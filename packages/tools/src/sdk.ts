export type ReserveSdkModule = typeof import("@reserve-protocol/sdk");

const importSdk = new Function("specifier", "return import(specifier)") as (
  specifier: string,
) => Promise<ReserveSdkModule>;

let sdkModulePromise: Promise<ReserveSdkModule> | undefined;

export async function loadSdk(): Promise<ReserveSdkModule> {
  sdkModulePromise ??= importSdk("@reserve-protocol/sdk");
  return sdkModulePromise;
}
