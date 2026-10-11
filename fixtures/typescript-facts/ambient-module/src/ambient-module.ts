declare module "legacy-lib" {
  export function init(options: Options): void;
  export class Client {
    connect(): Promise<void>;
  }
}

declare function log(message: string): void;
