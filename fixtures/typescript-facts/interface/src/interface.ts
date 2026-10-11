export interface IAuthService extends IService, IDisposable<string> {
  readonly name: string;
  timeout?: number;
  login(user: string, password: string): Promise<boolean>;
  logout?(): void;
  new (config: Config): IAuthService;
  [key: string]: unknown;
}

interface Internal {}
