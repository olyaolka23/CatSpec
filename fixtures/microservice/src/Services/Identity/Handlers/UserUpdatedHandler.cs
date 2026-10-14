using Identity.Contracts;
using Microsoft.Extensions.Logging;

namespace Identity.Handlers;

/// <summary>Keeps the user read model in sync with the identity service.</summary>
public partial class UserUpdatedHandler(ILogger logger, IEventStore store)
    : IMessageHandler<UserUpdatedEvent>
{
    private readonly ILogger _logger = logger;
}
