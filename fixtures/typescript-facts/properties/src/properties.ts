export class Settings {
  name: string = "default";
  private readonly id: number;
  static instances = 0;
  declare extra?: string;
  public timeout!: number;
  handler = (event: Event): void => {
    console.log(event);
  };
}
