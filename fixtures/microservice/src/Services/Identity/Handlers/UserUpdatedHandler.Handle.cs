using Identity.Contracts;
using Microsoft.Extensions.Logging;

namespace Identity.Handlers;

public partial class UserUpdatedHandler
{
    public async Task HandleAsync(UserUpdatedEvent message, CancellationToken cancellationToken)
    {
        if (await store.ExistsAsync(message.MessageId, cancellationToken))
        {
            return;
        }

        _logger.LogInformation("user {UserId} updated", message.UserId);
        await store.AppendAsync(message, cancellationToken);
    }
}
