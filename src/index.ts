import express from 'express';
import { SerialPort } from 'serialport';
import { ethers } from 'ethers';
import path from 'path';
import { fileURLToPath } from 'url';

interface SerialResponse {
  success: boolean;
  message: string;
}

const recyclingSystemAbi = [
  "event ContentsPurchased(uint256 indexed garbageCanId, address indexed collector, uint256 value)"
];

const CONTRACT_CONFIG = {
  address: '0x6900384BA33f8C635DeE2C3BD7d46A0626FfB096',
  rpcUrl: 'https://testnet.evm.nodes.onflow.org'
};

class BlockchainListener {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private deviceController: DeviceController;
  private lastBlockChecked: number;
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly POLLING_INTERVAL_MS = 5000; // 5 seconds

  constructor(deviceController: DeviceController) {
    this.deviceController = deviceController;
    this.provider = new ethers.JsonRpcProvider(CONTRACT_CONFIG.rpcUrl);
    this.contract = new ethers.Contract(
      CONTRACT_CONFIG.address,
      recyclingSystemAbi,
      this.provider
    );
    this.lastBlockChecked = 0;
  }

  public async startListening(): Promise<void> {
    console.log(`Starting to listen for ContentsPurchased events on contract ${CONTRACT_CONFIG.address}`);
    
    try {
      // Get the current block number to start listening from
      this.lastBlockChecked = await this.provider.getBlockNumber();
      console.log(`Starting to listen from block ${this.lastBlockChecked}`);
      
      // Start polling for events
      this.pollingInterval = setInterval(() => {
        this.checkForEvents().catch(error => {
          console.error('Error checking for events:', error);
        });
      }, this.POLLING_INTERVAL_MS);
      
      // Do an initial check
      await this.checkForEvents();
    } catch (error) {
      console.error('Error starting blockchain listener:', error);
    }
  }
  
  private async checkForEvents(): Promise<void> {
    try {
      const currentBlock = await this.provider.getBlockNumber();
      
      if (currentBlock <= this.lastBlockChecked) {
        console.log(`No new blocks since last check (current: ${currentBlock}, last checked: ${this.lastBlockChecked})`);
        return;
      }
      
      console.log(`Checking for events from block ${this.lastBlockChecked + 1} to ${currentBlock}`);
      
      // Get the event signature hash
      const eventSignature = ethers.id(
        "ContentsPurchased(uint256,address,uint256)"
      );
      
      // Get logs for the event
      const logs = await this.provider.getLogs({
        fromBlock: this.lastBlockChecked + 1,
        toBlock: currentBlock,
        address: CONTRACT_CONFIG.address,
        topics: [eventSignature]
      });
      
      // Process each log
      for (const log of logs) {
        const parsedLog = this.contract.interface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });
        
        if (parsedLog && parsedLog.name === 'ContentsPurchased') {
          const { garbageCanId, collector, value } = parsedLog.args;
          
          console.log(`ContentsPurchased event detected!`);
          console.log(`Garbage Can ID: ${garbageCanId}`);
          console.log(`Collector: ${collector}`);
          console.log(`Value: ${value}`);
          
          // Send command to open the door using the helper function
          try {
            const response = await sendCommandWithRetry(this.deviceController, '4');
            console.log(`Door open command sent: ${response.message}`);
          } catch (error) {
            console.error(`Failed to open door: ${(error as Error).message}`);
          }
        }
      }
      
      // Update the last checked block
      this.lastBlockChecked = currentBlock;
    } catch (error) {
      console.error('Error checking for events:', error);
    }
  }
  
  public stopListening(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      console.log('Blockchain event listener stopped');
    }
  }
}

import fs from 'fs';

class DeviceController {
  private port: SerialPort | null = null;
  private isConnected: boolean = false;
  private portPath: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private readonly MAX_RECONNECT_ATTEMPTS = Infinity; // Never give up trying to reconnect
  private readonly INITIAL_RECONNECT_DELAY = 1000; // 1 second
  private readonly MAX_RECONNECT_DELAY = 30000; // 30 seconds
  private commandQueue: Array<{command: string, resolve: (value: SerialResponse) => void, reject: (reason: SerialResponse) => void}> = [];
  private deviceCheckInterval: NodeJS.Timeout | null = null;
  private readonly DEVICE_CHECK_INTERVAL_MS = 5000; // 5 seconds

  constructor(portPath: string) {
    this.portPath = portPath;
    
    // Start checking for device availability
    this.startDeviceCheck();
    
    // Initial connection attempt
    this.initializePort();
  }
  
  private initializePort(): void {
    // Check if device exists before creating SerialPort
    if (this.deviceExists()) {
      console.log(`Device ${this.portPath} exists, initializing port...`);
      try {
        this.port = new SerialPort({
          path: this.portPath,
          baudRate: 115200,
          autoOpen: false // Don't auto-open, we'll handle it manually
        });
        
        this.setupPortListeners();
        
        // Try to open the port
        this.connect().catch(err => {
          console.error('Failed to connect to device during initialization:', err);
        });
      } catch (err) {
        console.error(`Error initializing SerialPort: ${err}`);
        this.startReconnection();
      }
    } else {
      console.log(`Device ${this.portPath} does not exist, waiting for it to become available...`);
      this.startReconnection();
    }
  }
  
  private deviceExists(): boolean {
    try {
      // Check if the device file exists
      return fs.existsSync(this.portPath);
    } catch (err) {
      console.error(`Error checking if device exists: ${err}`);
      return false;
    }
  }
  
  private startDeviceCheck(): void {
    // Clear any existing interval
    if (this.deviceCheckInterval !== null) {
      clearInterval(this.deviceCheckInterval);
    }
    
    // Set up interval to periodically check for device
    this.deviceCheckInterval = setInterval(() => {
      const deviceExists = this.deviceExists();
      
      if (deviceExists && !this.isConnected && this.reconnectTimer === null) {
        console.log(`Device ${this.portPath} detected, attempting connection...`);
        this.startReconnection();
      } else if (!deviceExists && this.isConnected) {
        console.log(`Device ${this.portPath} no longer exists but we're connected. This is unexpected.`);
        // Force disconnect to trigger reconnection
        if (this.port && this.port.isOpen) {
          this.port.close(err => {
            if (err) {
              console.error(`Error closing port: ${err}`);
            }
          });
        }
      }
    }, this.DEVICE_CHECK_INTERVAL_MS);
  }

  private setupPortListeners(): void {
    if (!this.port) {
      console.error('Cannot set up listeners: port is null');
      return;
    }
    
    // Remove any existing listeners to prevent duplicates
    this.port.removeAllListeners();
    
    this.port.on('open', () => {
      console.log(`Serial port ${this.portPath} opened successfully`);
      this.isConnected = true;
      this.reconnectAttempts = 0;
      
      // Process any queued commands when connection is restored
      this.processCommandQueue();
    });

    this.port.on('error', (err) => {
      console.error(`Serial port error on ${this.portPath}:`, err);
      this.isConnected = false;
      
      // Start reconnection process if not already started
      this.startReconnection();
    });

    this.port.on('close', () => {
      console.log(`Serial port ${this.portPath} closed`);
      this.isConnected = false;
      
      // Start reconnection process if not already started
      this.startReconnection();
    });
  }

  private startReconnection(): void {
    // Only start reconnection if not already attempting
    if (this.reconnectTimer === null) {
      console.log('Starting reconnection process...');
      this.attemptReconnect();
    }
  }

  private attemptReconnect(): void {
    // Clear any existing timer
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Check if max attempts reached
    if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`Max reconnection attempts (${this.MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      // Reject any queued commands
      this.rejectAllQueuedCommands('Max reconnection attempts reached');
      return;
    }

    // Calculate backoff delay with exponential increase, but cap at MAX_RECONNECT_DELAY
    const delay = Math.min(
      this.INITIAL_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts),
      this.MAX_RECONNECT_DELAY
    );
    
    console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts + 1}/${this.MAX_RECONNECT_ATTEMPTS})...`);
    
    this.reconnectTimer = setTimeout(() => {
      // Create a new SerialPort instance
      this.recreatePort();
      
      // Increment attempt counter
      this.reconnectAttempts++;
    }, delay);
  }

  private recreatePort(): void {
    // Clean up old port if it exists
    if (this.port) {
      try {
        this.port.removeAllListeners();
        if (this.port.isOpen) {
          this.port.close();
        }
      } catch (err) {
        console.error('Error cleaning up old port:', err);
      }
    }

    // Create a new port instance
    console.log(`Recreating port with path: ${this.portPath}`);
    this.port = new SerialPort({
      path: this.portPath,
      baudRate: 115200,
      autoOpen: true
    });

    // Set up listeners on the new port
    this.setupPortListeners();
  }

  private processCommandQueue(): void {
    console.log(`Processing command queue (${this.commandQueue.length} commands)`);
    
    // Process all queued commands
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift();
      if (cmd) {
        console.log(`Executing queued command: ${cmd.command}`);
        // Execute the command directly without re-queuing
        this.executeCommand(cmd.command)
          .then(cmd.resolve)
          .catch(cmd.reject);
      }
    }
  }

  private rejectAllQueuedCommands(reason: string): void {
    console.log(`Rejecting all queued commands (${this.commandQueue.length}) due to: ${reason}`);
    
    while (this.commandQueue.length > 0) {
      const cmd = this.commandQueue.shift();
      if (cmd) {
        cmd.reject({ 
          success: false, 
          message: `Command ${cmd.command} failed: ${reason}` 
        });
      }
    }
  }

  public connect(): Promise<SerialResponse> {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        resolve({ success: true, message: 'Already connected' });
        return;
      }

      if (!this.port) {
        reject({ success: false, message: 'Port is not initialized' });
        return;
      }

      // Reset reconnection attempts when manually connecting
      this.reconnectAttempts = 0;
      
      // Clear any existing reconnection timer
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.port.open((err: Error | null) => {
        if (err !== null) {
          reject({ success: false, message: `Failed to open port: ${err.message}` });
          return;
        }
        resolve({ success: true, message: 'Connected successfully' });
      });
    });
  }

  private executeCommand(command: string): Promise<SerialResponse> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject({ success: false, message: 'Device not connected' });
        return;
      }

      if (!this.port) {
        reject({ success: false, message: 'Port is not initialized' });
        return;
      }

      this.port.write(`${command}`, (err: Error | null | undefined) => {
        if (err !== null && err !== undefined) {
          this.isConnected = false; // Mark as disconnected on write error
          reject({ success: false, message: `Failed to send command: ${err.message}` });
          return;
        }
        resolve({ success: true, message: `Command ${command} sent successfully` });
      });
    });
  }

  public sendCommand(command: string): Promise<SerialResponse> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        console.log(`Device not connected, queuing command: ${command}`);
        
        // Queue the command for later execution
        this.commandQueue.push({
          command,
          resolve,
          reject
        });
        
        // Start reconnection process if not already started
        this.startReconnection();
        return;
      }

      // If connected, execute immediately
      this.executeCommand(command)
        .then(resolve)
        .catch(reject);
    });
  }

  public cleanup(): void {
    console.log('Cleaning up device controller resources...');
    
    // Clear device check interval
    if (this.deviceCheckInterval !== null) {
      clearInterval(this.deviceCheckInterval);
      this.deviceCheckInterval = null;
    }
    
    // Clear any reconnection timer
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    // Reject any queued commands
    this.rejectAllQueuedCommands('Application shutting down');
    
    // Close the port if it's open
    if (this.port && this.port.isOpen) {
      try {
        this.port.close();
        console.log('Serial port closed');
      } catch (err) {
        console.error('Error closing serial port:', err);
      }
    }
  }
}

const app = express();
const port = 3000;

// Get the directory path in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, '../public')));

// Serve the index.html file at the root URL
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Initialize the device controller with the path to the USB device
// The controller will automatically try to connect and reconnect as needed
const device = new DeviceController('/dev/ttyACM0');

// No need to call connect() here as the controller handles this internally
// and will keep trying to reconnect if the device is not available
console.log(`Device controller initialized for ${'/dev/ttyACM0'}`);

// Helper function to send commands with retry logic
async function sendCommandWithRetry(device: DeviceController, command: string, maxRetries = 3): Promise<SerialResponse> {
  let retryCount = 0;
  const retryDelay = 2000; // 2 seconds
  
  while (true) {
    try {
      return await device.sendCommand(command);
    } catch (error) {
      retryCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      if (retryCount >= maxRetries) {
        console.error(`Failed to send command ${command} after ${maxRetries} attempts: ${errorMessage}`);
        throw error; // Re-throw the error after max retries
      }
      
      console.warn(`Command ${command} failed (attempt ${retryCount}/${maxRetries}): ${errorMessage}. Retrying in ${retryDelay/1000} seconds...`);
      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
}

app.get('/plastic', async (_req, res) => {
  try {
    const result = await sendCommandWithRetry(device, '1');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/metal', async (_req, res) => {
  try {
    const result = await sendCommandWithRetry(device, '2');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/other', async (_req, res) => {
  try {
    const result = await sendCommandWithRetry(device, '3');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});


app.get('/open_door', async (_req, res) => {
  try {
    const result = await sendCommandWithRetry(device, '4');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/close_door', async (_req, res) => {
  try {
    const result = await sendCommandWithRetry(device, '5');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${port} (accessible on all network interfaces)`);
  
  // Start listening for blockchain events
  const blockchainListener = new BlockchainListener(device);
  blockchainListener.startListening()
    .then(() => {
      console.log('Blockchain event listener started successfully');
    })
    .catch(error => {
      console.error('Failed to start blockchain listener:', error);
    });
});


// Handle application shutdown
process.on('SIGINT', () => {
  console.log('Application shutting down...');
  
  // Clean up device resources
  device.cleanup();
  
  // Give a small delay to allow cleanup logs to be printed
  setTimeout(() => {
    process.exit(0);
  }, 500);
});
