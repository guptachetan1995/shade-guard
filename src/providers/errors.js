// YouCam errors and the sentence a shopper or the store sees for each.

// field and outline are set on unexpected_shape: the field that was missing or wrong, and the
// response's field names and value types (never its values), so a shape the spike didn't
// record can be fixed without printing a URL or an id.
export class YouCamError extends Error {
  constructor(code, { status = null, message = null, feature = null, taskId = null, field = null, outline = null } = {}) {
    super(message ?? code);
    this.code = code;
    this.status = status;
    this.feature = feature;
    this.taskId = taskId;
    this.field = field;
    this.outline = outline;
  }
}

// Engine errors that mean "take the photo again", each with one sentence of guidance.
export const RETAKE_GUIDANCE = Object.freeze({
  error_below_min_image_size: "The photo is too small. Use one at least 480 pixels on its short side.",
  error_face_position_invalid: "Centre your face in the oval.",
  error_face_position_too_small: "Move closer, so your face fills the oval.",
  error_face_position_out_of_boundary: "Keep your whole face inside the frame.",
  error_face_not_forward_facing: "Face the camera straight on.",
  error_face_angle_upward: "Tilt your head down slightly.",
  error_face_angle_downward: "Tilt your head up slightly.",
  error_face_angle_leftward: "Your face is turned to one side. Turn it back to face the camera.",
  error_face_angle_rightward: "Your face is turned to one side. Turn it back to face the camera.",
  error_face_angle_left_tilt: "Your head is tilted. Hold it level.",
  error_face_angle_right_tilt: "Your head is tilted. Hold it level.",
  error_face_angle_invalid: "Face the camera straight on, within about 10 degrees.",
  error_large_face_angle: "Face the camera straight on.",
  error_no_face: "No face was found. Face the camera in good light.",
  error_multiple_people: "Only one person should be in the photo.",
  error_decode_image: "The photo couldn't be read. Take a new one.",
  exceed_max_filesize: "The photo file is too large. Take a new one.",
});

export const KEY_NOT_ACCEPTED = new Set(["InvalidApiKey", "InvalidAccessToken"]);

export function isRetake(code) {
  return Object.hasOwn(RETAKE_GUIDANCE, code);
}

export function messageFor(code) {
  if (isRetake(code)) return RETAKE_GUIDANCE[code];
  if (KEY_NOT_ACCEPTED.has(code)) return "The API key was not accepted.";
  switch (code) {
    case "CreditInsufficiency":
      return "This store's try-on budget is used up.";
    case "RateLimited":
      return "The analysis service is busy. Trying again shortly.";
    case "TaskTimeout":
      return "The analysis took too long and stopped. Try again.";
    case "InvalidTaskId":
      return "That analysis no longer exists.";
    case "OperationInvalid":
      return "That analysis is still running.";
    case "not_recorded":
      return "This replay has no recording for that request; new requests need live mode.";
    case "new_photo_needs_live":
      return "New photos need live mode. This replay only has the sample shopper's recorded photo.";
    case "unexpected_shape":
      return "The analysis service answered in a shape this app doesn't know, so nothing was used.";
    case "network_error":
      return "The analysis service couldn't be reached.";
    case "upload_failed":
      return "The photo upload to the analysis service failed.";
    case "result_fetch_failed":
      return "The try-on image couldn't be downloaded.";
    default:
      return `The analysis service returned ${code}.`;
  }
}
