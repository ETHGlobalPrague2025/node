import { ethers } from 'ethers';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

const recyclingSystemAbi = [
  "event GarbageCanCreated(uint256 indexed id, string location)",
  "event StakeDeposited(uint256 indexed pendingGarbageCanId, address indexed staker, uint256 amount)",
  "event GarbageCanDeployed(uint256 indexed pendingGarbageCanId, uint256 indexed garbageCanId)",
  "event FillLevelUpdated(uint256 indexed garbageCanId, uint8 recyclableType, uint256 amount, uint256 value)",
  "event ContentsPurchased(uint256 indexed garbageCanId, address indexed collector, uint256 value)",
  "event PendingGarbageCanCreated(uint256 indexed pendingGarbageCanId, string location, uint256 targetAmount)",
  
  "function createPendingGarbageCan(string memory location, uint256 targetAmount) external",
  "function stakeForGarbageCan(uint256 pendingGarbageCanId, uint256 amount) external",
  "function updateFillLevel(uint256 garbageCanId, uint8 recyclableType, uint256 amount, uint256 value) external",
  "function buyContents(uint256 garbageCanId) external",
  "function getGarbageCanInfo(uint256 garbageCanId) external view returns (string memory location, uint256 currentValue, bool isActive, bool isLocked, uint256 deploymentTimestamp, uint256 lastEmptiedTimestamp, uint256 totalStaked)"
];

const erc20Abi = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function mint(uint256 amount) external"
];

enum RecyclableType {
  PLASTIC,
  METAL,
  OTHER
}

// Configuration from environment variables
const CONTRACT_CONFIG = {
  address: process.env.CONTRACT_ADDRESS || '0x0EFafca24E5BbC1C01587B659226B9d600fd671f',
  rpcUrl: process.env.RPC_URL || 'https://testnet.evm.nodes.onflow.org',
  privateKey: process.env.PRIVATE_KEY || '',
  usdcAddress: process.env.USDC_ADDRESS || ''
};

// Validate configuration
if (!CONTRACT_CONFIG.privateKey) {
  console.error('Error: PRIVATE_KEY environment variable is required');
  process.exit(1);
}

if (!CONTRACT_CONFIG.usdcAddress) {
  console.error('Error: USDC_ADDRESS environment variable is required');
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    console.log('Starting test purchase script...');
    
    // Connect to the blockchain
    const provider = new ethers.JsonRpcProvider(CONTRACT_CONFIG.rpcUrl);
    const wallet = new ethers.Wallet(CONTRACT_CONFIG.privateKey, provider);
    const signer = wallet.connect(provider);
    
    console.log(`Connected to network with wallet address: ${wallet.address}`);
    
    // Create contract instances
    const recyclingSystem = new ethers.Contract(
      CONTRACT_CONFIG.address,
      recyclingSystemAbi,
      signer
    );
    
    const usdc = new ethers.Contract(
      CONTRACT_CONFIG.usdcAddress,
      erc20Abi,
      signer
    );
    
    // Check USDC balance and mint if needed
    const balance = await usdc.balanceOf(wallet.address);
    console.log(`Current USDC balance: ${ethers.formatUnits(balance, 6)} USDC`);
    
    // Mint 1000 USDC if balance is low
    if (balance < ethers.parseUnits('1000', 6)) {
      const mintAmount = ethers.parseUnits('1000', 6);
      console.log(`Minting ${ethers.formatUnits(mintAmount, 6)} USDC...`);
      const mintTx = await usdc.mint(mintAmount);
      await mintTx.wait();
      
      const newBalance = await usdc.balanceOf(wallet.address);
      console.log(`New USDC balance after minting: ${ethers.formatUnits(newBalance, 6)} USDC`);
    }
    
    // Find an existing garbage can or create a new one
    let garbageCanId = await findExistingGarbageCan(recyclingSystem);
    
    if (garbageCanId === null) {
      console.log('No existing garbage can found. Creating a new one...');
      garbageCanId = await createNewGarbageCan(recyclingSystem, usdc);
    }
    
    console.log(`Using garbage can ID: ${garbageCanId}`);
    
    // Get garbage can info
    const garbageCanInfo = await recyclingSystem.getGarbageCanInfo(garbageCanId);
    console.log('Garbage can info:', {
      location: garbageCanInfo[0],
      currentValue: garbageCanInfo[1],
      isActive: garbageCanInfo[2],
      isLocked: garbageCanInfo[3],
      deploymentTimestamp: garbageCanInfo[4],
      lastEmptiedTimestamp: garbageCanInfo[5],
      totalStaked: garbageCanInfo[6]
    });
    
    // If the garbage can has no value, update its fill level
    if (garbageCanInfo[1].toString() === '0') {
      console.log('Garbage can has no value. Updating fill level...');
      await updateGarbageCanFillLevel(recyclingSystem, garbageCanId);
      
      // Get updated garbage can info
      const updatedInfo = await recyclingSystem.getGarbageCanInfo(garbageCanId);
      console.log('Updated garbage can value:', updatedInfo[1].toString());
    }
    
    // Get updated garbage can info after updating fill level
    const updatedGarbageCanInfo = await recyclingSystem.getGarbageCanInfo(garbageCanId);
    
    // Calculate payment amount (50% of the current value)
    const currentValue = updatedGarbageCanInfo[1];
    const paymentAmount = calculatePaymentAmount(currentValue);
    console.log(`Current garbage can value: ${ethers.formatUnits(currentValue, 6)} USDC`);
    console.log(`Payment amount needed: ${ethers.formatUnits(paymentAmount, 6)} USDC`);
    
    // Check current allowance
    const currentAllowance = await usdc.allowance(wallet.address, CONTRACT_CONFIG.address);
    console.log(`Current allowance: ${ethers.formatUnits(currentAllowance, 6)} USDC`);
    
    // Approve USDC for the contract if needed
    if (currentAllowance < paymentAmount) {
      console.log(`Approving ${ethers.formatUnits(paymentAmount, 6)} USDC for the contract...`);
      const approveTx = await usdc.approve(CONTRACT_CONFIG.address, paymentAmount);
      await approveTx.wait();
      console.log('USDC approved successfully');
    } else {
      console.log('Sufficient allowance already exists, no need to approve again');
    }
    
    // Buy contents to trigger ContentsPurchased event
    console.log(`Buying contents of garbage can ${garbageCanId}...`);
    const buyTx = await recyclingSystem.buyContents(garbageCanId);
    const receipt = await buyTx.wait();
    
    // Check for ContentsPurchased event
    const contentsPurchasedEvent = receipt.logs
      .filter((log: any) => {
        try {
          const parsedLog = recyclingSystem.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          return parsedLog !== null && parsedLog.name === 'ContentsPurchased';
        } catch (e) {
          return false;
        }
      })
      .map((log: any) => {
        try {
          const parsedLog = recyclingSystem.interface.parseLog({
            topics: log.topics,
            data: log.data
          });
          
          if (parsedLog !== null) {
            return {
              garbageCanId: parsedLog.args.garbageCanId,
              collector: parsedLog.args.collector,
              value: parsedLog.args.value
            };
          }
          return null;
        } catch (e) {
          return null;
        }
      })
      .filter((event: any) => event !== null);
    
    if (contentsPurchasedEvent.length > 0) {
      console.log('ContentsPurchased event emitted successfully!');
      console.log('Event data:', contentsPurchasedEvent[0]);
    } else {
      console.log('ContentsPurchased event not found in transaction receipt');
    }
    
    console.log('Test purchase completed successfully');
  } catch (error) {
    console.error('Error in test purchase script:', error);
    process.exit(1);
  }
}

async function findExistingGarbageCan(contract: ethers.Contract): Promise<number | null> {
  try {
    // Try to find an existing garbage can by checking a few IDs
    for (let i = 0; i < 10; i++) {
      try {
        const info = await contract.getGarbageCanInfo(i);
        if (info[2]) { // isActive
          console.log(`Found active garbage can with ID ${i}`);
          return i;
        }
      } catch (e) {
        // Garbage can doesn't exist, continue checking
      }
    }
    return null;
  } catch (error) {
    console.error('Error finding existing garbage can:', error);
    return null;
  }
}

async function createNewGarbageCan(
  recyclingSystem: ethers.Contract,
  usdc: ethers.Contract
): Promise<number> {
  try {
    // Create a pending garbage can
    const location = `Test Location ${Date.now()}`;
    const targetAmount = ethers.parseUnits('100', 6); // 100 USDC
    
    console.log(`Creating pending garbage can at location "${location}" with target amount ${targetAmount}...`);
    const createTx = await recyclingSystem.createPendingGarbageCan(location, targetAmount);
    const createReceipt = await createTx.wait();
    
    // Find the pending garbage can ID from the event
    let pendingGarbageCanId: number | null = null;
    for (const log of createReceipt.logs) {
      try {
        const parsedLog = recyclingSystem.interface.parseLog({
          topics: log.topics,
          data: log.data
        });
        if (parsedLog !== null && parsedLog.name === 'PendingGarbageCanCreated') {
          pendingGarbageCanId = parsedLog.args.pendingGarbageCanId;
          break;
        }
      } catch (e) {
        // Not the event we're looking for
      }
    }
    
    if (pendingGarbageCanId === null) {
      // If we can't find the event, assume it's the first pending garbage can
      pendingGarbageCanId = 0;
    }
    
    console.log(`Pending garbage can created with ID: ${pendingGarbageCanId}`);
    
    // Approve USDC for staking
    const stakingAmount = targetAmount;
    console.log(`Approving ${stakingAmount} USDC for staking...`);
    const approveTx = await usdc.approve(CONTRACT_CONFIG.address, stakingAmount);
    await approveTx.wait();
    
    // Stake for the garbage can
    console.log(`Staking ${stakingAmount} USDC for pending garbage can ${pendingGarbageCanId}...`);
    const stakeTx = await recyclingSystem.stakeForGarbageCan(pendingGarbageCanId, stakingAmount);
    const stakeReceipt = await stakeTx.wait();
    
    // Find the deployed garbage can ID from the event
    let garbageCanId: number | null = null;
    for (const log of stakeReceipt.logs) {
      try {
        const parsedLog = recyclingSystem.interface.parseLog({
          topics: log.topics,
          data: log.data
        });
        if (parsedLog !== null && parsedLog.name === 'GarbageCanDeployed') {
          garbageCanId = parsedLog.args.garbageCanId;
          break;
        }
      } catch (e) {
        // Not the event we're looking for
      }
    }
    
    if (garbageCanId === null) {
      throw new Error('Failed to find deployed garbage can ID');
    }
    
    console.log(`Garbage can deployed with ID: ${garbageCanId}`);
    return garbageCanId;
  } catch (error) {
    console.error('Error creating new garbage can:', error);
    throw error;
  }
}

async function updateGarbageCanFillLevel(
  contract: ethers.Contract,
  garbageCanId: number
): Promise<void> {
  try {
    const recyclableType = RecyclableType.PLASTIC;
    const amount = 10; // 10 units of plastic
    const value = ethers.parseUnits('50', 6); // 50 USDC value
    
    console.log(`Updating fill level of garbage can ${garbageCanId}...`);
    const tx = await contract.updateFillLevel(garbageCanId, recyclableType, amount, value);
    await tx.wait();
    console.log('Fill level updated successfully');
  } catch (error) {
    console.error('Error updating garbage can fill level:', error);
    throw error;
  }
}

function calculatePaymentAmount(currentValue: ethers.BigNumberish): ethers.BigNumberish {
  // Payment amount is 50% of the current value (PLATFORM_FEE_PERCENT = 50)
  return (ethers.getBigInt(currentValue) * ethers.getBigInt(50) * ethers.getBigInt(100)) / ethers.getBigInt(10000);
}

// Run the script
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
