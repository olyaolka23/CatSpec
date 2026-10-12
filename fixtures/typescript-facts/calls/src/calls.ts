import { logger } from "./logger";

logger.info("module loaded");

export class AuthService {
  login(user: string): void {
    console.log(user);
    this.audit . record(user);
    validate(user)?.then(() => notify());
  }

  private audit = createAudit();
}

export function helper(): void {
  setTimeout(() => {
    run();
  }, 10);
}
