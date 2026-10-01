//! "One day": the Old Town Square from one spot while the clock runs from before dawn to
//! night (filmed by `day/film.sh`), the time large in the corner, the day's course along
//! the bottom, then the title.
use crate::TrailerMedia;
use fframes::{
    AudioMap, AudioTimestamp::*, AudioTrack, Color, Duration, FFramesContext, Frame, Scene, Scenes, Svgr,
    SyncVideoFrameInput, Video,
};

const FPS: f32 = 30.0;
/// The film's frames, and the minutes of the day at its first and last (as in day/shot.js).
const FILM: f32 = 720.0;
const FROM: f32 = 4.0 * 60.0 + 40.0;
const TO: f32 = 23.0 * 60.0 + 40.0;
const TITLE_FRAMES: f32 = 150.0;
const PAPER: &str = "#f3ecdd";
const RED: &str = "#d8362d";
const AMBER: &str = "#ffc480";
const TITLE: &str = "Bebas Neue";
const MONO: &str = "IBM Plex Mono";
const TEXT: &str = "DM Sans";

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let u = ((x - a) / (b - a)).clamp(0.0, 1.0);
    u * u * (3.0 - 2.0 * u)
}

pub struct DayVideo<'a> {
    pub media: &'a TrailerMedia,
    whole: Whole,
}

impl<'a> DayVideo<'a> {
    pub fn new(media: &'a TrailerMedia) -> Self {
        Self { media, whole: Whole }
    }
}

impl std::fmt::Debug for DayVideo<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DayVideo").finish()
    }
}

impl Video for DayVideo<'_> {
    const FPS: usize = 30;
    const WIDTH: usize = crate::WIDTH;
    const HEIGHT: usize = crate::HEIGHT;
    const BACKGROUND_COLOR: Color = Color::BLACK;

    fn duration(&self) -> Duration<'_> {
        Duration::Auto
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::from([AudioTrack::new("day.wav", Second(0.)..Eof)])
    }

    fn define_scenes(&self) -> Scenes<'_> {
        Scenes::from(vec![&self.whole as &dyn Scene])
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" width={crate::WIDTH} height={crate::HEIGHT} viewBox="0 0 1920 1080">
                <rect width="1920" height="1080" fill="#090b10" />
                {ctx.render_scenes(&frame)}
            </svg>
        )
    }
}

#[derive(Debug)]
struct Whole;

impl Scene for Whole {
    fn duration(&self) -> Duration<'_> {
        Duration::Seconds((FILM + TITLE_FRAMES) / FPS)
    }

    fn render_frame<'a>(&'a self, frame: Frame, ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        use fframes::FFramesSyncedVideoFrame;
        let f = frame.index as f32;
        // (The clip holds its last frame for the title: day/film.sh pads it.)
        let day = (f / (FILM - 1.0)).min(1.0);
        let minutes = (FROM + (TO - FROM) * day).round() as usize;
        let clock = format!("{:02}:{:02}", minutes / 60, minutes % 60);
        let picture = frame
            .get_synced_video_frame(ctx, "day.mp4", &SyncVideoFrameInput { start_from: 0.0, looping: false, editor_fallback_image: None })
            .map(|v| v.into_image());
        let film = match picture {
            Some(image) => fframes::svgr!(<image href={image.href()} x="0" y="0" width="1920" height="1080" opacity={smooth(0.0, 40.0, f)} />),
            None => fframes::svgr!(<g></g>),
        };
        let t = f - FILM;
        let titled = smooth(0.0, 30.0, t);
        // The day's course: a line from dawn to night, a dot where the clock is, the hours marked.
        let x = 96.0 + 1728.0 * day;
        let marks: Vec<Svgr> = [6usize, 9, 12, 15, 18, 21]
            .into_iter()
            .map(|h| {
                let at = 96.0 + 1728.0 * (h as f32 * 60.0 - FROM) / (TO - FROM);
                fframes::svgr!(<g opacity={if (h * 60) as f32 <= minutes as f32 { 0.9 } else { 0.35 }}>
                    <rect x={at - 1.0} y="986" width="2" height="12" fill={PAPER} />
                    <text x={at} y="1030" text-anchor="middle" font-family={MONO} font-size="20" letter-spacing="3" fill={PAPER}>{format!("{h:02}")}</text>
                </g>)
            })
            .collect();
        fframes::svgr!(<g>
            {film}
            <rect width="1920" height="1080" fill="#000000" opacity={0.62 * titled} />
            <g opacity={smooth(20.0, 50.0, f) * (1.0 - titled)}>
                <text x="100" y="204" font-family={TITLE} font-size="170" letter-spacing="4" fill="#000000" opacity="0.45">{clock.clone()}</text>
                <text x="96" y="200" font-family={TITLE} font-size="170" letter-spacing="4" fill={PAPER}>{clock}</text>
                <rect x="96" y="226" width="64" height="4" fill={RED} />
                <text x="96" y="276" font-family={MONO} font-size="28" letter-spacing="6" fill={PAPER} opacity="0.85">"STAROMĚSTSKÉ NÁMĚSTÍ"</text>
                <rect x="96" y="984" width="1728" height="2" fill={PAPER} opacity="0.3" />
                <rect x="96" y="984" width={(x - 96.0).max(0.5)} height="2" fill={AMBER} />
                <circle cx={x} cy="985" r="7" fill={AMBER} />
                {marks}
            </g>
            <g opacity={smooth(8.0, 34.0, t) * (1.0 - smooth(TITLE_FRAMES - 18.0, TITLE_FRAMES - 2.0, t))}>
                <text x="960" y="470" text-anchor="middle" font-family={MONO} font-size="30" letter-spacing="10" fill={AMBER}>"ONE DAY IN"</text>
                <text x="960" y="660" text-anchor="middle" font-family={TITLE} font-size="236" letter-spacing="10" fill={PAPER}>"STREETS OF PRAGUE"</text>
                <rect x="690" y="706" width="540" height="7" fill={RED} />
                <text x="960" y="790" text-anchor="middle" font-family={TEXT} font-size="40" letter-spacing="3" fill={PAPER} opacity={smooth(26.0, 50.0, t)}>"The clock, the sun and the lamps follow Prague's."</text>
                <text x="960" y="866" text-anchor="middle" font-family={TITLE} font-size="64" letter-spacing="6" fill={AMBER} opacity={smooth(36.0, 60.0, t)}>"STREETSOFPRAGUE.COM"</text>
            </g>
        </g>)
    }
}
