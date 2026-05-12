/**
 * @param {string} url
 * @param {NodeJS.Platform} [platform]
 */
export function browserLaunchCommand(url, platform = process.platform) {
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url]
    };
  }

  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }

  return { command: "xdg-open", args: [url] };
}