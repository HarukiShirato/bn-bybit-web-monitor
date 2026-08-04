const CURRENT = '/home/ec2-user/perp-dashboard';
const SHARED_DATA = `${CURRENT}/data`;

const collector = (name, script) => ({
  name,
  script,
  cwd: CURRENT,
  interpreter: 'node',
  autorestart: true,
  env: {
    NODE_ENV: 'production',
    PERP_DATA_DIR: SHARED_DATA,
  },
});

module.exports = {
  apps: [
    {
      name: 'perp-dashboard',
      script: 'npm',
      args: 'start',
      cwd: CURRENT,
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
      },
    },
    collector('funding-collector', 'scripts/funding-collector.js'),
    collector('arbitrage-collector', 'scripts/arbitrage-collector.js'),
    collector('staking-collector', 'scripts/staking-collector.js'),
    collector('positions-collector', 'scripts/positions-collector.js'),
  ],
};
