/**
 * 应用程序配置
 */

export interface AppConfig {
  // 网络配置
  network: {
    rpcEndpoint: string;
    websocketEndpoint?: string;
    chainId: number;
    blockTime: number;
  };
  
  // 扫描器配置
  scanner: {
    pollInterval: number;
    maxBlockRange: number;
    enableWebSocket: boolean;
  };
  
  // 日志配置
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    enableConsole: boolean;
    enableFile: boolean;
  };
  
  // 测试配置
  testing: {
    testBlockStart: number;
    testBlockEnd: number;
    enableMockMode: boolean;
  };
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: AppConfig = {
  network: {
    rpcEndpoint: 'http://172.16.3.16:8547',
    websocketEndpoint: 'ws://172.16.3.16:8546',
    chainId: 1,
    blockTime: 12
  },
  
  scanner: {
    pollInterval: 12000, // 12秒
    maxBlockRange: 10,
    enableWebSocket: true
  },
  
  logging: {
    level: 'info',
    enableConsole: true,
    enableFile: false
  },
  
  testing: {
    testBlockStart: 1000,
    testBlockEnd: 1010,
    enableMockMode: false
  }
};

/**
 * 获取配置
 */
export function getConfig(): AppConfig {
  // 这里可以从环境变量或配置文件读取
  // 目前返回默认配置
  return DEFAULT_CONFIG;
}

/**
 * 更新配置
 */
export function updateConfig(updates: Partial<AppConfig>): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...updates
  };
}
