using Identity.Contracts;
using Microsoft.Extensions.Logging;

namespace Identity.Handlers;

public partial class UserUpdatedHandler
{
    public async Task HandleMessageAsync(UserUpdatedEvent message, CancellationToken cancellationToken)
    {
        if (await store.ExistsAsync(message.MessageId, cancellationToken))
        {
            return;
        }

        Console.WriteLine($"user {message.UserId} updated");
        await store.AppendAsync(message, cancellationToken);
    }
}
