/** Prints a VAPID key pair for web push; paste into deploy/.env. */
import { generateVapidKeys } from "../services/notify.js";

const { publicKey, privateKey } = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
