#!/bin/bash
# Checks everything a GPU job needs except the GPU, on a CPU node in about a minute, so a GPU
# job never waits hours in the queue only to fail on the network:
#
#   srun -p short -t 00:10:00 --mem=4G bash /projects/huskyswap/code/ml/hpc/preflight.sh
#
set -uo pipefail
source /projects/huskyswap/code/ml/hpc/env.sh
trap 'stop_vllm; kill ${SERVER:-} 2> /dev/null' EXIT
cd "$HS_CODE"
fails=0
check() { if [ "$2" = 0 ]; then echo "ok    $1"; else echo "FAIL  $1"; fails=$((fails + 1)); fi; }

# A stand-in for the model servers: curl (the readiness check), Python (the smoke test) and
# Node (datagen and eval) must all reach 127.0.0.1 directly, not through the proxy
python3 -m http.server 8999 --bind 127.0.0.1 > /dev/null 2>&1 &
SERVER=$!
sleep 2
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:8999/)" = 200 ]
check "curl reaches local servers" $?
"$HS/env/vllm/bin/python" -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8999/', timeout=5)" 2> /dev/null
check "python reaches local servers" $?
node -e "fetch('http://127.0.0.1:8999/').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
check "node reaches local servers" $?

db_tunnel
check "database tunnel" $?

# Both logins the jobs use, through the tunnel, the way the app connects
node --input-type=module -e "
import pg from 'pg';
for (const v of ['NLQ_DATABASE_URL', 'DATABASE_URL']) {
  const db = new pg.Client({ connectionString: process.env[v], ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
  await db.connect();
  const { rows } = await db.query('select current_user');
  console.log('      ' + v + ' connects as ' + rows[0].current_user);
  await db.end();
}" 2>&1 | tail -3
check "database queries" "${PIPESTATUS[0]}"

# The embedding model (retrieval, the novelty filter) downloads through the proxy and is cached
node --input-type=module -e "
import { env, pipeline } from '@huggingface/transformers';
env.cacheDir = process.env.EMBED_CACHE_DIR;
const embed = await pipeline('feature-extraction', 'Supabase/gte-small', { dtype: 'q8' });
const out = await embed(['how many listings are there?'], { pooling: 'mean', normalize: true });
console.log('      embedding has ' + out.dims[1] + ' dimensions');" 2>&1 | tail -2
check "embedding model" "${PIPESTATUS[0]}"

for f in .env.local ml/datasets/work/questions.jsonl; do [ -f "$f" ]; check "$f present" $?; done
echo
[ "$fails" = 0 ] && echo "preflight passed: GPU jobs can go" || echo "preflight: $fails check(s) failed"
exit "$fails"
