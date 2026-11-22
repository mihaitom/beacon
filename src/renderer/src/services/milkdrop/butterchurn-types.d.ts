// Butterchurn ships no types; this covers the part Beacon calls.
declare module 'butterchurn' {
  /** A converted Milkdrop preset - opaque to Beacon, handed through as-is. */
  export type MilkdropPreset = Record<string, unknown>

  export interface MilkdropVisualizer {
    connectAudio(node: AudioNode): void
    disconnectAudio(node: AudioNode): void
    /** Blends from the current preset over `blendSeconds`. */
    loadPreset(preset: MilkdropPreset, blendSeconds?: number): void
    setRendererSize(width: number, height: number, opts?: { pixelRatio?: number }): void
    /** Without `audioLevels` it reads the connected audio node itself. */
    render(opts?: {
      audioLevels?: {
        timeByteArray: Uint8Array
        timeByteArrayL: Uint8Array
        timeByteArrayR: Uint8Array
      }
    }): void
  }

  export interface Butterchurn {
    createVisualizer(
      context: BaseAudioContext,
      canvas: HTMLCanvasElement,
      opts: { width: number; height: number; pixelRatio?: number; textureRatio?: number },
    ): MilkdropVisualizer
  }

  // Typed as either shape on purpose - see services/milkdrop/butterchurn.ts.
  const butterchurn: Butterchurn | { default: Butterchurn }
  export default butterchurn
}
