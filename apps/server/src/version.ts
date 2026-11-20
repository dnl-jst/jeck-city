import { readFileSync } from 'node:fs';

/** The release version: `version` of the repository's root package.json (see AGENTS.md), read once at startup. */
export const SERVER_VERSION: string = (JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
