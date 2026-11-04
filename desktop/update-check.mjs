export function createUpdateCheckGate() {
  let active = null;
  let interactions = [];
  return {
    track(interaction) {
      const pending = Promise.resolve(interaction);
      pending.catch(() => {});
      interactions.push(pending);
    },
    run(check) {
      if (active) return active;
      interactions = [];
      const operation = Promise.resolve().then(async () => {
        const result = await check();
        for (let index = 0; index < interactions.length; index++) {
          await interactions[index];
        }
        return result;
      });
      const shared = operation.finally(() => {
        if (active === shared) active = null;
      });
      active = shared;
      return shared;
    }
  };
}
