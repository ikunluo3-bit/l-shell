import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else {
    fputs("usage: flatten_png.swift <input.png> <output.png>\n", stderr)
    exit(2)
}

let inputURL = URL(fileURLWithPath: args[1])
let outputURL = URL(fileURLWithPath: args[2])

guard let source = CGImageSourceCreateWithURL(inputURL as CFURL, nil),
      let inputImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fputs("failed to load input PNG: \(inputURL.path)\n", stderr)
    exit(1)
}

let width = inputImage.width
let height = inputImage.height
let colorSpace = CGColorSpaceCreateDeviceRGB()
let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

guard let context = CGContext(
    data: nil,
    width: width,
    height: height,
    bitsPerComponent: 8,
    bytesPerRow: width * 4,
    space: colorSpace,
    bitmapInfo: bitmapInfo
) else {
    fputs("failed to create RGB context\n", stderr)
    exit(1)
}

context.setFillColor(red: 0.945, green: 0.918, blue: 0.875, alpha: 1)
context.fill(CGRect(x: 0, y: 0, width: width, height: height))
context.draw(inputImage, in: CGRect(x: 0, y: 0, width: width, height: height))

guard let outputImage = context.makeImage(),
      let destination = CGImageDestinationCreateWithURL(outputURL as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fputs("failed to create output PNG\n", stderr)
    exit(1)
}

CGImageDestinationAddImage(destination, outputImage, nil)
guard CGImageDestinationFinalize(destination) else {
    fputs("failed to write output PNG\n", stderr)
    exit(1)
}
