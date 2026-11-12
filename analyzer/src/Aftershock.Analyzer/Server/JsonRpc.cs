using System.Buffers;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Threading.Channels;
using Aftershock.Analyzer.Output;

namespace Aftershock.Analyzer.Server;

/// <summary>JSON-RPC 2.0 error codes used by the server (documented in docs/analyzer-cli.md).</summary>
public static class JsonRpcErrorCodes
{
    public const int ParseError = -32700;
    public const int InvalidRequest = -32600;
    public const int MethodNotFound = -32601;
    public const int InvalidParams = -32602;
    public const int InternalError = -32603;

    /// <summary>The workspace could not be loaded (or is not loaded yet after a failed load).</summary>
    public const int WorkspaceUnavailable = -32001;

    /// <summary>A request other than initialize, status, shutdown arrived before initialize.</summary>
    public const int ServerNotInitialized = -32002;

    /// <summary>The request was cancelled ($/cancelRequest), superseded by a newer request, or the server shut down.</summary>
    public const int RequestCancelled = -32800;
}

/// <summary>An incoming message, already validated as a JSON-RPC 2.0 request or notification.</summary>
/// <param name="Method">Method name.</param>
/// <param name="Id">Raw JSON of the id (a number or a string); null for notifications.</param>
/// <param name="Params">The params object (cloned), or null when absent.</param>
public sealed record IncomingMessage(string Method, string? Id, JsonElement? Params)
{
    public bool IsNotification => Id is null;
}

/// <summary>
/// Newline-delimited JSON-RPC 2.0 framing: one JSON object per line, UTF-8, no Content-Length headers. All writes
/// go through one queue so messages never interleave.
/// </summary>
public sealed class JsonRpcChannel
{
    public static readonly JsonSerializerOptions SerializerOptions = new(ReportJson.Options)
    {
        WriteIndented = false,
    };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        Indented = false,
    };

    private readonly Stream _output;
    private readonly Channel<byte[]> _queue = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true });
    private readonly Task _writer;

    public JsonRpcChannel(Stream output)
    {
        _output = output;
        _writer = Task.Run(WriteLoopAsync);
    }

    /// <summary>Set when writing to the output failed (the client went away).</summary>
    public event Action<Exception>? WriteFailed;

    /// <summary>
    /// Parses one line. Returns the message, or an error response to send (with the id when it could be read).
    /// </summary>
    public static (IncomingMessage? Message, string? ErrorId, int ErrorCode, string? ErrorMessage) Parse(string line)
    {
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(line);
        }
        catch (JsonException ex)
        {
            return (null, null, JsonRpcErrorCodes.ParseError, $"parse error: {ex.Message}");
        }

        using (document)
        {
            var root = document.RootElement;
            if (root.ValueKind == JsonValueKind.Array)
            {
                return (null, null, JsonRpcErrorCodes.InvalidRequest, "batch requests are not supported; send one JSON object per line");
            }

            if (root.ValueKind != JsonValueKind.Object)
            {
                return (null, null, JsonRpcErrorCodes.InvalidRequest, "a message must be a JSON object");
            }

            string? id = null;
            if (root.TryGetProperty("id", out var idElement))
            {
                if (idElement.ValueKind is not (JsonValueKind.Number or JsonValueKind.String))
                {
                    return (null, null, JsonRpcErrorCodes.InvalidRequest, "'id' must be a number or a string");
                }

                id = idElement.GetRawText();
            }

            if (!root.TryGetProperty("jsonrpc", out var version) || version.ValueKind != JsonValueKind.String || version.GetString() != "2.0")
            {
                return (null, id, JsonRpcErrorCodes.InvalidRequest, "'jsonrpc' must be \"2.0\"");
            }

            if (!root.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(method.GetString()))
            {
                return (null, id, JsonRpcErrorCodes.InvalidRequest, "'method' must be a non-empty string");
            }

            JsonElement? parameters = null;
            if (root.TryGetProperty("params", out var p) && p.ValueKind != JsonValueKind.Null)
            {
                if (p.ValueKind != JsonValueKind.Object)
                {
                    return (null, id, id is null ? 0 : JsonRpcErrorCodes.InvalidParams, "'params' must be an object (named parameters)");
                }

                parameters = p.Clone();
            }

            return (new IncomingMessage(method.GetString()!, id, parameters), null, 0, null);
        }
    }

    public void SendResult(string id, object? result)
    {
        Enqueue(writer =>
        {
            writer.WriteString("jsonrpc", "2.0");
            writer.WritePropertyName("id");
            writer.WriteRawValue(id, skipInputValidation: true);
            writer.WritePropertyName("result");
            JsonSerializer.Serialize(writer, result, result?.GetType() ?? typeof(object), SerializerOptions);
        });
    }

    public void SendError(string? id, int code, string message, object? data = null)
    {
        Enqueue(writer =>
        {
            writer.WriteString("jsonrpc", "2.0");
            writer.WritePropertyName("id");
            if (id is null)
            {
                writer.WriteNullValue();
            }
            else
            {
                writer.WriteRawValue(id, skipInputValidation: true);
            }

            writer.WriteStartObject("error");
            writer.WriteNumber("code", code);
            writer.WriteString("message", message);
            if (data is not null)
            {
                writer.WritePropertyName("data");
                JsonSerializer.Serialize(writer, data, data.GetType(), SerializerOptions);
            }

            writer.WriteEndObject();
        });
    }

    public void SendNotification(string method, object parameters)
    {
        Enqueue(writer =>
        {
            writer.WriteString("jsonrpc", "2.0");
            writer.WriteString("method", method);
            writer.WritePropertyName("params");
            JsonSerializer.Serialize(writer, parameters, parameters.GetType(), SerializerOptions);
        });
    }

    /// <summary>Stops accepting messages and waits (bounded) until everything queued has been written.</summary>
    public async Task CompleteAsync(TimeSpan timeout)
    {
        _queue.Writer.TryComplete();
        await Task.WhenAny(_writer, Task.Delay(timeout)).ConfigureAwait(false);
    }

    private void Enqueue(Action<Utf8JsonWriter> body)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var writer = new Utf8JsonWriter(buffer, WriterOptions))
        {
            writer.WriteStartObject();
            body(writer);
            writer.WriteEndObject();
        }

        var bytes = new byte[buffer.WrittenCount + 1];
        buffer.WrittenSpan.CopyTo(bytes);
        bytes[^1] = (byte)'\n';
        _queue.Writer.TryWrite(bytes);
    }

    private async Task WriteLoopAsync()
    {
        var reader = _queue.Reader;
        try
        {
            while (await reader.WaitToReadAsync().ConfigureAwait(false))
            {
                while (reader.TryRead(out var message))
                {
                    await _output.WriteAsync(message).ConfigureAwait(false);
                }

                await _output.FlushAsync().ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            _queue.Writer.TryComplete();
            WriteFailed?.Invoke(ex);
        }
    }
}
