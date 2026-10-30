// npm run balance: the YouCam unit balance, from the free credit endpoint, and nothing else.
// It confirms a key works without anyone seeing the key: no key, header or response body is
// printed. With no key configured it refuses and sends nothing.
import { describeError, liveFromConfig } from "./live-cli.js";

const { provider } = liveFromConfig("npm run balance");
try {
  const { units } = await provider.getBalance();
  process.stdout.write(`YouCam balance: ${units} units\n`);
} catch (e) {
  process.stderr.write(`npm run balance: ${describeError(e)}`);
  process.exit(1);
}
