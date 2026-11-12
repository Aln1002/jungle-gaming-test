set -euo pipefail

bun run build
NODE_ENV=production pm2 start bun --name "distributed-wagering-processor-prod" --update-env -- run start:prod
