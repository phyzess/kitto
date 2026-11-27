#!/usr/bin/env node
import { maintain } from '../lib/kitto.ts';
try {
  await maintain(process.argv.slice(2));
} catch (error) {
  console.error(`Kitto: ${(error as Error).message}`);
  process.exitCode = 1;
}
