export class AuthService {
  constructor(
    private log: ILogger,
    public readonly config: Config,
    protected repo?: IUserRepository,
    plain: string,
  ) {}
}
