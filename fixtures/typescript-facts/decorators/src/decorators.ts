@Controller("/users")
export class UsersController {
  @Inject() private readonly service!: UsersService;

  @Get(":id")
  @UseGuards(AuthGuard, RolesGuard)
  find(@Param("id") id: string): User {
    return this.service.find(id);
  }
}

@Injectable
class Plain {}
