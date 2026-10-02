use fframes::{CombinedMediaProvider, EncoderOptions, MediaDirectory, MediaProvider, RenderOptions, StaticMediaProvider, cli};
use fframes_skia_renderer::{
    SkiaFFramesRenderer, SkiaPipelineConcurrencyPolicy, SkiaPipelineConfig,
    metal::SkiaMetalCtx,
};
use trailer::{street::StreetVideo, TrailerMedia, HEIGHT, WIDTH};
use fframes::cli::clap; // the derive below expands to `clap::...`
use std::process::ExitCode;

/// Flags of this video next to the standard ones of `fframes::cli` (render, frame, strip, inspect, audio, ...).
#[derive(Debug, clap::Args)]
struct VideoArgs {
    /// The lines in Czech.
    #[arg(long, global = true)]
    czech: bool,
    /// The version filmed straight down throughout.
    #[arg(long, global = true)]
    top: bool,
    /// Only the pictures: no bars, labels, lines, numbers or title.
    #[arg(long, global = true)]
    clean: bool,
}

fn main() -> ExitCode {
    let args = cli::parse::<VideoArgs>();
    let media = TrailerMedia::prepare().expect("media");
    // The filmed clips, next to the sources (street/film.sh puts them there).
    let clips_dir = MediaDirectory::read_folder(concat!(env!("CARGO_MANIFEST_DIR"), "/clips")).expect("the clips folder: run trailer/street/film.sh first");
    let clips = clips_dir.process_media_source().expect("clips");
    let all_media = CombinedMediaProvider::from([&media as &dyn MediaProvider, &clips as &dyn MediaProvider]);
    let video = StreetVideo::new(&media, args.app.czech, args.app.top, args.app.clean);
    let gpu = SkiaMetalCtx::new(WIDTH, HEIGHT).expect("GPU context");

    cli::new(
        &video,
        RenderOptions {
            media: Some(&all_media),
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("libx264"),
                codec_params: Some(&[("crf", "16"), ("preset", "medium"), ("tune", "film")]),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .args(args)
    .backend(
        SkiaFFramesRenderer::new_metal(
            &gpu,
            SkiaPipelineConfig {
                concurrency_policy: SkiaPipelineConcurrencyPolicy::MaxPerformance,
                ..Default::default()
            },
        )
        .expect("skia renderer"),
    )
    .preview(fframes_native_player::cli_preview)
    .run()
}
