import express from 'express';
import { SerialPort } from 'serialport';

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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
