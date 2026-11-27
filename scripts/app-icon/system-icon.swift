// Renders app icons the way macOS draws them (NSWorkspace, so Tahoe's own treatment of a legacy icon is
// included), as PNGs. Used by scripts/app-icon/capture.mjs; macOS only.
//   swift system-icon.swift <size px> <out dir> <bundle path>...
// Writes <out dir>/<bundle name>.png for each bundle that exists and prints one line per file written.
// ICON_APPEARANCE=dark draws them in the dark appearance (macOS 26 icons from an asset catalog have one).
import AppKit

let args = CommandLine.arguments
guard args.count >= 4, let size = Int(args[1]) else {
  FileHandle.standardError.write("usage: system-icon.swift <size> <out dir> <bundle>...\n".data(using: .utf8)!)
  exit(2)
}
let outDir = URL(fileURLWithPath: args[2])
for path in args[3...] {
  guard FileManager.default.fileExists(atPath: path) else { continue }
  let icon = NSWorkspace.shared.icon(forFile: path)
  icon.size = NSSize(width: size, height: size)
  guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                                   samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                   bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
  rep.size = NSSize(width: size, height: size)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  let appearance = NSAppearance(named: ProcessInfo.processInfo.environment["ICON_APPEARANCE"] == "dark" ? .darkAqua : .aqua)!
  appearance.performAsCurrentDrawingAppearance {
    icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
  }
  NSGraphicsContext.restoreGraphicsState()
  let name = URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
  let out = outDir.appendingPathComponent(name + ".png")
  try rep.representation(using: .png, properties: [:])!.write(to: out)
  print(out.path)
}
