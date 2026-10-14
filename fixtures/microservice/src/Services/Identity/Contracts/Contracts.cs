namespace Identity.Contracts;

public interface IMessageHandler<TMessage>
{
    Task HandleAsync(TMessage message, CancellationToken cancellationToken);
}

public interface IEventStore
{
    Task<bool> ExistsAsync(Guid messageId, CancellationToken cancellationToken);

    Task AppendAsync(object message, CancellationToken cancellationToken);
}

public sealed record UserUpdatedEvent(Guid MessageId, Guid UserId, string? Email);
