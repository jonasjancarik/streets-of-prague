//! The release trailer of Streets of Prague: clips filmed from the game (`record.sh`,
//! `shots/`), cut together with a caption on each, between a title and a closing card.
//!
//! Each scene is a Rust struct that returns an SVG tree for every frame; `svgr!` is SVG
//! with `{rust expressions}` in attributes and text. Check the cut with the CLI in
//! `main.rs` (`cargo run --release -- --help`).
use fframes::{
    AnimateRuntimeInput, AudioMap, AudioTimestamp::*, AudioTrack, Color, Duration, FFramesContext, Frame, Scene,
    Scenes, Svgr, SyncVideoFrameInput, Video,
    animation::{AnimationRuntime, Easing},
    include_media_dir,
};
use std::sync::LazyLock;

pub mod atmo;
pub mod day;
pub mod launch;
pub mod street;
mod street_data;
mod atmo_data;
mod launch_data;

// The fonts and the sound in `media/` are embedded into the binary (fonts are used by
// family name); the clips are read from `clips/` when it runs (see main.rs).
include_media_dir!(pub struct TrailerMedia, "media");

pub const WIDTH: usize = 1920;
pub const HEIGHT: usize = 1080;

const PAPER: &str = "#f3ecdd";
const RED: &str = "#d8362d";
const NIGHT: &str = "#14110f";
const TITLE: &str = "Bebas Neue";
const TEXT: &str = "DM Sans";

/// Fast start, long settle: good for things sliding into place.
static EASE: LazyLock<AnimationRuntime> =
    LazyLock::new(|| AnimationRuntime::new(0.7, &Easing::CubicBezier(0.16, 1.0, 0.3, 1.0)));

/// 0 to 1 over 0.7 s from `start` (seconds into the scene).
fn ramp(frame: &Frame, start: f32) -> f32 {
    frame.animate_runtime(AnimateRuntimeInput { on_second: start, from: 0.0, to: 1.0, animation_runtime: &EASE })
}

/// The clips in order: file, seconds shown, caption.
const CLIPS: [(&str, f32, &str); 7] = [
    ("clip-day-drive.mp4", 4.5, "PRAGUE, STREET BY STREET"),
    ("clip-square.mp4", 4.0, "A CITY FULL OF PEOPLE"),
    ("clip-tram.mp4", 4.5, "TRAMS ON THEIR LINES"),
    ("clip-night-street.mp4", 4.5, "LAMPS COME ON AT DUSK"),
    ("clip-police.mp4", 3.2, "DON'T GET CAUGHT"),
    ("clip-bridge.mp4", 4.5, "ACROSS THE VLTAVA"),
    ("clip-rain.mp4", 4.5, "WHATEVER THE WEATHER"),
];
const INTRO_SECONDS: f32 = 2.4;
const OUTRO_SECONDS: f32 = 4.6;

pub struct TrailerVideo<'a> {
    pub media: &'a TrailerMedia,
    intro: Intro,
    clips: Vec<Clip>,
    outro: Outro<'a>,
}

impl<'a> TrailerVideo<'a> {
    pub fn new(media: &'a TrailerMedia, title: &'a str) -> Self {
        Self {
            media,
            intro: Intro,
            clips: CLIPS.iter().map(|&(file, seconds, caption)| Clip { file, seconds, caption }).collect(),
            outro: Outro { title },
        }
    }
}

impl std::fmt::Debug for TrailerVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrailerVideo").finish()
    }
}

impl Video for TrailerVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = WIDTH;
    const HEIGHT: usize = HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        // One track, mixed from the game's own sounds by `soundtrack.sh`.
        AudioMap::from([AudioTrack::new("soundtrack.wav", Second(0.)..Eof).fade_in(0.4).fade_out(1.5)])
    }

    fn define_scenes(&self) -> Scenes<'_> {
        let mut scenes: Vec<&dyn Scene> = vec![&self.intro];
        scenes.extend(self.clips.iter().map(|c| c as &dyn Scene));
        scenes.push(&self.outro);
        Scenes::from(scenes)
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={WIDTH} height={HEIGHT} viewBox="0 0 1920 1080">
                <rect width="1920" height="1080" fill={NIGHT} />
                {ctx.render_scenes(&frame)}
            </svg>
        )
    }
}

/// "Praha" on black, before the first clip.
#[derive(Debug)]
struct Intro;

impl Scene for Intro {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(INTRO_SECONDS)
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let out = 1.0 - ramp(&frame, INTRO_SECONDS - 0.5);
        let bar = (ramp(&frame, 0.15) * 240.0).max(0.5);
        fframes::svgr!(<g opacity={out}>
            <rect x={960.0 - bar / 2.0} y="596" width={bar} height="6" fill={RED} />
            <text x="960" y="560" text-anchor="middle" font-family={TITLE} font-size="150" letter-spacing="14" fill={PAPER} opacity={ramp(&frame, 0.1)}>"PRAHA"</text>
            <text x="960" y="668" text-anchor="middle" font-family={TEXT} font-size="34" letter-spacing="6" fill={PAPER} opacity={ramp(&frame, 0.5) * 0.8}>"THE WHOLE CITY IS THE MAP"</text>
        </g>)
    }
}

/// One clip filling the picture, drifting in a little, with its caption at the bottom left.
#[derive(Debug)]
struct Clip {
    file: &'static str,
    seconds: f32,
    caption: &'static str,
}

impl Scene for Clip {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(self.seconds)
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let picture = frame
            .get_synced_video_frame(ctx, self.file, &SyncVideoFrameInput { start_from: 0.0, looping: false, editor_fallback_image: None })
            .map(|v| {
                use fframes::FFramesSyncedVideoFrame;
                v.into_image()
            });
        // A slow push in, about the middle of the picture.
        let zoom = 1.0 + 0.05 * frame.seconds() / self.seconds;
        let push = format!("translate({} {}) scale({zoom})", 960.0 * (1.0 - zoom), 540.0 * (1.0 - zoom));
        let show = ramp(&frame, 0.35) * (1.0 - ramp(&frame, self.seconds - 0.6));
        let slide = (1.0 - ramp(&frame, 0.35)) * 40.0;
        let clip = match picture {
            Some(image) => fframes::svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080" transform={push} />),
            None => fframes::svgr!(<rect width="1920" height="1080" fill={NIGHT} />),
        };
        fframes::svgr!(<g>
            {clip}
            <g opacity={show} transform={format!("translate({} 0)", -slide)}>
                <rect x="96" y="884" width="12" height="92" fill={RED} />
                <text x="132" y="964" font-family={TITLE} font-size="112" letter-spacing="4" fill="#000000" opacity="0.55">{self.caption}</text>
                <text x="128" y="960" font-family={TITLE} font-size="112" letter-spacing="4" fill={PAPER}>{self.caption}</text>
            </g>
        </g>)
    }
}

/// The title and where to play.
#[derive(Debug)]
struct Outro<'a> {
    title: &'a str,
}

impl Scene for Outro<'_> {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds(OUTRO_SECONDS)
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let title = self.title.to_uppercase();
        let bar = (ramp(&frame, 0.5) * 520.0).max(0.5);
        let rise = (1.0 - ramp(&frame, 0.1)) * 50.0;
        fframes::svgr!(<g>
            <text x="960" y={560.0 + rise} text-anchor="middle" font-family={TITLE} font-size="230" letter-spacing="10" fill={PAPER} opacity={ramp(&frame, 0.1)}>{title}</text>
            <rect x={960.0 - bar / 2.0} y="606" width={bar} height="8" fill={RED} />
            <text x="960" y="700" text-anchor="middle" font-family={TEXT} font-size="44" letter-spacing="3" fill={PAPER} opacity={ramp(&frame, 0.9)}>"Play in your browser"</text>
            <text x="960" y="772" text-anchor="middle" font-family={TITLE} font-size="72" letter-spacing="6" fill={RED} opacity={ramp(&frame, 1.2)}>"STREETSOFPRAGUE.COM"</text>
        </g>)
    }
}
