 anchor deploy --provider.cluster testnet
Deploying cluster: https://api.testnet.solana.com
Upgrade authority: /home/x/.config/solana/id.json
Deploying program "cartridge_storage"...
Program path: /home/x/Documents/projects/solana-retro/program/target/deploy/cartridge_storage.so...
Program Id: iXBRbJjLtohupYmSDz3diKTVz2wU8NXe4gezFsSNcy1

Signature: 42kqvREFpVnx72Twa1v6cXmyjXezSCvMFzM6cxmhFMbKEAqamXZtaPDD9DTruzFLisPQG6ydxExJ2uTeAsZLeQNB

Waiting for program iXBRbJjLtohupYmSDz3diKTVz2wU8NXe4gezFsSNcy1 to be confirmed...
Program confirmed on-chain
Idl data length: 2138 bytes
Step 0/2138 
Step 600/2138 
Step 1200/2138 
Step 1800/2138 
Idl account created: 6qC6ykNxusHPyC9N2FRneSY4hKPzpC9Qo7Va7LBTjmaP
Deploy success

-----
npm run dev -- init --network testnet

> @solana-retro/cli@1.0.0 dev
> tsx src/index.ts init --network testnet

⠸ Checking catalog status...
Admin: FNrn9AzQq6sjAYbQTxwkeH6Bs8AZu1NH4NLKiUFxdhE3

Initialization is handled by the SDK. Use:

  import { CartridgeClient } from "@solana-retro/sdk";
  const client = new CartridgeClient("devnet");
  await client.initializeCatalog(adminKeypair);
ℹ Manual initialization required