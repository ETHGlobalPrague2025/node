import express from 'express';
import { SerialPort } from 'serialport';

// Define types
interface SerialResponse {
  success: boolean;
  message: string;
}

class DeviceController {
  private port: SerialPort;
  private isConnected: boolean = false;

  constructor(portPath: string) {
    this.port = new SerialPort({
      path: portPath,
      baudRate: 9600,
      autoOpen: false
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

  private sendCommand(command: string): Promise<SerialResponse> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        reject({ success: false, message: 'Device not connected' });
        return;
      }

      this.port.write(`${command}\n`, (err: Error | null | undefined) => {
        if (err !== null && err !== undefined) {
          reject({ success: false, message: `Failed to send command: ${err.message}` });
          return;
        }
        resolve({ success: true, message: `Command ${command} sent successfully` });
      });
    });
  }

  public async open(): Promise<SerialResponse> {
    return this.sendCommand('OPEN');
  }

  public async close(): Promise<SerialResponse> {
    return this.sendCommand('CLOSE');
  }

  public async sort(): Promise<SerialResponse> {
    return this.sendCommand('SORT');
  }
}

// Create Express application
const app = express();
const port = 3000;

// Create device controller instance
// Note: Replace '/dev/ttyUSB0' with your actual serial port
const device = new DeviceController('/dev/ttyUSB0');

// Connect to the device when the server starts
device.connect().catch((err) => {
  console.error('Failed to connect to device:', err);
});

// Define API routes
app.get('/open', async (_req, res) => {
  try {
    const result = await device.open();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/close', async (_req, res) => {
  try {
    const result = await device.close();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

app.get('/sort', async (_req, res) => {
  try {
    const result = await device.sort();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: (error as Error).message });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
