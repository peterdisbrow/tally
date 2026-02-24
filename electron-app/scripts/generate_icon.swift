import AppKit

let outPath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon-base-1024.png"
let size: CGFloat = 1024
let image = NSImage(size: NSSize(width: size, height: size))

image.lockFocus()

let rect = NSRect(x: 0, y: 0, width: size, height: size)

// Background gradient inside rounded square
let bgPath = NSBezierPath(roundedRect: rect.insetBy(dx: 28, dy: 28), xRadius: 220, yRadius: 220)
let bgGradient = NSGradient(colors: [
  NSColor(calibratedRed: 0.03, green: 0.09, blue: 0.08, alpha: 1.0),
  NSColor(calibratedRed: 0.08, green: 0.22, blue: 0.18, alpha: 1.0),
])!
bgGradient.draw(in: bgPath, angle: -65)

// Glow ring
let ringRect = NSRect(x: 174, y: 174, width: 676, height: 676)
let ringPath = NSBezierPath(ovalIn: ringRect)
ringPath.lineWidth = 24
NSColor(calibratedRed: 0.29, green: 0.89, blue: 0.58, alpha: 0.92).setStroke()
ringPath.stroke()

let innerRingRect = ringRect.insetBy(dx: 46, dy: 46)
let innerRingPath = NSBezierPath(ovalIn: innerRingRect)
innerRingPath.lineWidth = 10
NSColor(calibratedRed: 0.69, green: 0.96, blue: 0.83, alpha: 0.58).setStroke()
innerRingPath.stroke()

// Stylized T
let tText = NSString(string: "T")
let tAttrs: [NSAttributedString.Key: Any] = [
  .font: NSFont.systemFont(ofSize: 392, weight: .heavy),
  .foregroundColor: NSColor(calibratedRed: 0.96, green: 1.0, blue: 0.98, alpha: 1.0),
]
let tSize = tText.size(withAttributes: tAttrs)
let tPoint = NSPoint(x: (size - tSize.width) / 2, y: 278)
tText.draw(at: tPoint, withAttributes: tAttrs)

image.unlockFocus()

guard let tiff = image.tiffRepresentation,
      let rep = NSBitmapImageRep(data: tiff),
      let pngData = rep.representation(using: .png, properties: [.compressionFactor: 1.0]) else {
  fputs("Failed to render icon PNG\n", stderr)
  exit(1)
}

let url = URL(fileURLWithPath: outPath)
do {
  try pngData.write(to: url)
  print("Wrote \(outPath)")
} catch {
  fputs("Failed to write PNG: \(error)\n", stderr)
  exit(1)
}
