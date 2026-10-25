/**
 * 通知开关的持久化。
 *
 * 优先级：**用户运行时选择 > profile 配置里的默认值**。
 * 配置文件（cordis.patch.yml）只是初始种子；用户在面板上点的开关写到
 * `~/.dsh/dsh-msp/notify.json`，下次启动以它为准 —— 否则每次重启都会
 * 把用户关掉的提醒又打开，那开关就没意义了。
 *
 * 读写都容错：文件缺失、损坏、权限不足都退回默认值，绝不因为偏好文件
 * 拖垮插件启动。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const NOTIFY_KEYS = ["approval", "question", "turnEnd"];

export const KEY_LABELS = {
  approval: "有操作等我确认",
  question: "模型在问我问题",
  turnEnd: "任务完成",
};

export function prefsPath(home = os.homedir()) {
  return path.join(home, ".dsh", "dsh-msp", "notify.json");
}

export function defaultPrefs(config = {}) {
  return {
    approval: config.notifyOnApproval !== false,
    question: config.notifyOnQuestion !== false,
    turnEnd: config.notifyOnTurnEnd !== false,
  };
}

/** 读偏好；缺字段的用 defaults 补齐（兼容旧文件）。 */
export function loadPrefs(file, defaults) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    const merged = { ...defaults };
    for (const key of NOTIFY_KEYS) {
      if (typeof raw?.[key] === "boolean") merged[key] = raw[key];
    }
    return merged;
  } catch {
    return { ...defaults };
  }
}

/** 落盘（尽力而为）。返回是否写成功。 */
export function savePrefs(file, prefs) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const payload = {};
    for (const key of NOTIFY_KEYS) payload[key] = Boolean(prefs[key]);
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}
