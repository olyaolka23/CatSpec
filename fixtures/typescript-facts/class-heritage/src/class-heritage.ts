import { Base, IHandler, Events } from "./contracts";

export class UserHandler extends Base<User> implements IHandler<Events.UserUpdated>, Disposable {}

export class Plain extends Base {}

export class Qualified extends lib.Component<Props, State> {}
