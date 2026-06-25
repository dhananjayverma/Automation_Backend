class SseHub {
  constructor() {
    this.clientsByJob = new Map();
    this.recentByJob = new Map();
    this.maxBufferedEvents = 100;
  }

  subscribe(jobId, res) {
    const clients = this.clientsByJob.get(jobId) || new Set();
    clients.add(res);
    this.clientsByJob.set(jobId, clients);

    return () => {
      clients.delete(res);
      if (clients.size === 0) {
        this.clientsByJob.delete(jobId);
      }
    };
  }

  broadcast(jobId, event) {
    this.remember(jobId, event);
    const clients = this.clientsByJob.get(jobId);
    if (!clients) {
      return;
    }

    const payload = formatSse(event);
    for (const client of clients) {
      client.write(payload);
    }
  }

  remember(jobId, event) {
    const buffer = this.recentByJob.get(jobId) || [];
    buffer.push(event);
    if (buffer.length > this.maxBufferedEvents) {
      buffer.shift();
    }
    this.recentByJob.set(jobId, buffer);
  }
}

function formatSse(event) {
  return `id: ${event.eventId}\nevent: job-event\ndata: ${JSON.stringify(event)}\n\n`;
}

module.exports = { sseHub: new SseHub(), formatSse };
