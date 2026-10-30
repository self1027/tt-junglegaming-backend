const pid = Number(await Bun.file('/tmp/dwp-worker-ready').text());
if (!Number.isSafeInteger(pid) || pid < 1) process.exit(1);
process.kill(pid, 0);
