import { fetchLod2Tiles, fetchOsm } from './fetch';

const RAW_DIR = 'data/raw';

async function main() {
  const fetchOnly = process.argv.includes('--fetch-only');
  await fetchLod2Tiles(`${RAW_DIR}/lod2`);
  await fetchOsm(RAW_DIR);
  if (fetchOnly) return;
  console.log('nippes-nights pipeline: weitere Schritte folgen');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
