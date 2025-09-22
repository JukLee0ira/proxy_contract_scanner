// Jest setup file
// This file runs after Jest environment is set up

// Set longer timeout for integration tests
jest.setTimeout(30000);

// Helper functions for validating Ethereum data
(global as any).isValidEthereumAddress = (address: string): boolean => {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
};

(global as any).isValidBlockNumber = (blockNumber: any): boolean => {
  return typeof blockNumber === 'number' && blockNumber >= 0 && Number.isInteger(blockNumber);
};
