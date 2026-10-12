export namespace Billing {
  export class Invoice {
    total(): number {
      return 0;
    }
  }

  export namespace Tax {
    export function rate(country: string): number {
      return 0.2;
    }
  }
}

namespace Outer.Inner {
  export interface Shape {}
}
