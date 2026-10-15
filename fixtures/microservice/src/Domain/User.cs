namespace Domain;

public sealed class User
{
    public Guid Id { get; init; }

    public string? Email { get; set; }
}
