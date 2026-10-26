using Identity.Contracts;
using Microsoft.Extensions.Logging;

namespace Identity.Handlers;

/// <summary>Keeps the user read model in sync with the identity service.</summary>
public sealed class UserHandler(ILogger logger, IEventStore store) : IMessageHandler<UserUpdatedEvent>
{
    public async Task HandleAsync(UserUpdatedEvent message, CancellationToken cancellationToken)
    {
        if (await store.ExistsAsync(message.MessageId, cancellationToken))
        {
            return;
        }

        logger.LogInformation("user {UserId} updated", message.UserId);
        await store.AppendAsync(message, cancellationToken);
    }
}
