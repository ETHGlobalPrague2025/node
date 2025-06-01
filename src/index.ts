import express from 'express';
import { SerialPort } from 'serialport';
import { ethers } from 'ethers';

interface SerialResponse {
  success: boolean;
  message: string;
}

const recyclingSystemAbi = [
  "event ContentsPurchased(uint256 indexed garbageCanId, address indexed collector, uint256 value)"
];

const CONTRACT_CONFIG = {
  address: '0x0EFafca24E5BbC1C01587B659226B9d600fd671f',
  rpcUrl: 'https://testnet.evm.nodes.onflow.org'
};

class BlockchainListener {
  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private deviceController: DeviceController;
  private lastBlockChecked: number;
  private pollingInterval: NodeJS.Timeout | null = null;
  private readonly POLLING_INTERVAL_MS = 15000; // 15 seconds

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
          
          // Send command to open the door
          try {
            const response = await this.deviceController.sendCommand('4');
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

class DeviceController {
  private port: SerialPort;
  private isConnected: boolean = false;

  constructor(portPath: string) {
    this.port = new SerialPort({
      path: portPath,
      baudRate: 115200,
      autoOpen: true
    });

    this.setupPortListeners();
  }

  private setupPortListeners(): void {
    this.port.on('open', () => {
      console.log('Serial port opened');
      this.isConnected = true;
    });

    this.port.on('error', (err) => {
      console.error('Serial port error:', err);
      this.isConnected = false;
    });

    this.port.on('close', () => {
      console.log('Serial port closed');
      this.isConnected = false;
    });
  }

  public connect(): Promise<SerialResponse> {
    return new Promise((resolve, reject) => {
      if (this.isConnected) {
        resolve({ success: true, message: 'Already connected' });
        return;
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

  public sendCommand(command: string): Promise<SerialResponse> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject({ success: false, message: 'Device not connected' });
        return;
      }

      this.port.write(`${command}`, (err: Error | null | undefined) => {
        if (err !== null && err !== undefined) {
          reject({ success: false, message: `Failed to send command: ${err.message}` });
          return;
        }
        resolve({ success: true, message: `Command ${command} sent successfully` });
      });
    });
  }
}

const app = express();
const port = 3000;

const device = new DeviceController('/dev/ttyACM0');

device.connect().catch((err) => {
  console.error('Failed to connect to device:', err);
});

app.get('/plastic', async (_req, res) => {
  try {
    const result = await device.sendCommand('1');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/metal', async (_req, res) => {
  try {
    const result = await device.sendCommand('2');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/other', async (_req, res) => {
  try {
    const result = await device.sendCommand('3');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});


app.get('/open', async (_req, res) => {
  try {
    const result = await device.sendCommand('4');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/close', async (_req, res) => {
  try {
    const result = await device.sendCommand('5');
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
  process.exit(0);
});
