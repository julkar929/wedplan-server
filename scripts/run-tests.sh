#!/bin/bash
# Starts a throwaway mongod (if none is running) and runs the full API test-suite.
cd "$(dirname "$0")/.."
MONGOD=${MONGOD_BIN:-mongod}
if ! (echo > /dev/tcp/127.0.0.1/27099) 2>/dev/null; then
  mkdir -p /tmp/wp-mongo && $MONGOD --dbpath /tmp/wp-mongo --port 27099 --bind_ip 127.0.0.1 --fork --logpath /tmp/wp-mongo.log >/dev/null
fi
TEST_MONGO=mongodb://127.0.0.1:27099 npx tsx --test --test-concurrency=1 tests/*.test.ts
