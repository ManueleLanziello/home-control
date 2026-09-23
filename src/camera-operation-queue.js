// One active PyTapo operation per physical camera. Interactive work goes before
// queued background reads; a failed operation always releases the camera.
export class CameraOperationQueue {
  constructor() { this.queues = new Map(); }

  run(id, operation, { background = false } = {}) {
    let queue = this.queues.get(id);
    if (!queue) { queue = { active: false, interactive: [], background: [] }; this.queues.set(id, queue); }
    return new Promise((resolve, reject) => {
      (background ? queue.background : queue.interactive).push({ operation, resolve, reject });
      if (!queue.active) this.drain(id, queue);
    });
  }

  async drain(id, queue) {
    queue.active = true;
    try {
      while (queue.interactive.length || queue.background.length) {
        const item = queue.interactive.shift() || queue.background.shift();
        try { item.resolve(await item.operation()); }
        catch (error) { item.reject(error); }
      }
    } finally {
      queue.active = false;
      if (queue.interactive.length || queue.background.length) this.drain(id, queue);
      else this.queues.delete(id);
    }
  }
}
