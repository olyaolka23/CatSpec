using Identity.Contracts;

namespace Infrastructure.Persistence;

public sealed class SqlEventStore : IEventStore
{
    public Task<bool> ExistsAsync(Guid messageId, CancellationToken cancellationToken) =>
        Task.FromResult(false);

    public Task AppendAsync(object message, CancellationToken cancellationToken) =>
        Task.CompletedTask;
}
