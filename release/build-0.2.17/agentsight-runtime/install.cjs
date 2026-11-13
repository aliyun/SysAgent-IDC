const { prepareAgentSight } = require('./agentsight-deployment.cjs');
prepareAgentSight({ packageDirectories: [__dirname] }).then(() => { console.log('AgentSight 用户级程序、API 配置和数据目录已准备；已有配置保留，未启动采集'); }).catch(() => { console.error('AgentSight 独立安装失败，请检查安装件与用户目录权限'); process.exitCode = 1; });
