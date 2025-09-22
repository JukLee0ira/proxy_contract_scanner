// Jest type declarations
/// <reference types="jest" />

declare namespace jest {
  interface Matchers<R> {
    toBeEthereumAddress(): R;
    toBeValidBlockNumber(): R;
  }
}
