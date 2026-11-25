#!/usr/bin/env node
import { maintain } from '../lib/kitto.mjs';
try {
  await maintain(process.argv.slice(2));
} catch (error) {
  console.error(`Kitto: ${error.message}`);
  process.exitCode = 1;
}
