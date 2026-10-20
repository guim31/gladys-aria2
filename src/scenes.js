// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+).
//
// The use cases: a film starts on the TV, a video call begins → pause the
// downloads or slow them down, and back when it ends; a scene (a message, a
// button, a schedule) adds a link. The two switches of the device are
// already Gladys scene actions ("control a device"); these add a limit of
// any value and the link. Gladys applies no field default to the actions:
// every field read here is optional or required.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async add_uri(hub, { fields = {} }) {
    return { gid: await hub.addUri(fields.uri, fields.dir) };
  },

  async pause_all(hub) {
    await hub.pauseAll();
  },

  async resume_all(hub) {
    await hub.resumeAll();
  },

  async set_download_limit(hub, { fields = {} }) {
    await hub.setDownloadLimit(fields.limit);
  },
};
