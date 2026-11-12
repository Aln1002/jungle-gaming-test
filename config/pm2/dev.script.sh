set -euo pipefail

NODE_ENV=development pm2 start bun --name "distributed-wagering-processor-dev" -- run start:dev
