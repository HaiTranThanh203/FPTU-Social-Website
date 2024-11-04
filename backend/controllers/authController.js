const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const Email = require('../utils/email');
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};
const createSendToken = (user, statusCode, res) => {
  const token = signToken(user._id);
  user.password = undefined;
  res.status(statusCode).json({
    status: 'success',
    token,
    user,
  });
};

// Check if email already exists
exports.checkEmail = catchAsync(async (req, res, next) => {
  const { email } = req.body;

  const existingUser = await User.findOne({ email });
  if (existingUser) {
    return next(new AppError('Email is already registered. Please use a different email.', 400));
  }

  res.status(200).json({
    status: 'success',
    message: 'Email is available.',
  });
});

// Check if student code already exists
exports.checkStudentCode = catchAsync(async (req, res, next) => {
  const { studentCode } = req.body;

  const existingStudentCode = await User.findOne({ studentCode });
  if (existingStudentCode) {
    return next(new AppError('Student code is already registered. Please use a different student code.', 400));
  }

  res.status(200).json({
    status: 'success',
    message: 'Student Code is available.',
  });
});

// Signup function
exports.signup = catchAsync(async (req, res, next) => {
  const { email, username, password, studentCode } = req.body;

  // Create new user
  const newUser = await User.create({
    email,
    username,
    password, 
    studentCode
  });

  res.status(200).json({
    status: 'success',
    message: 'Email registered successfully! Please create a username and password.',
  });
});


// New function to check if the username is taken
exports.checkUsername = catchAsync(async (req, res, next) => {
  const { username } = req.body;

  const existingUser = await User.findOne({ username });
  if (existingUser) {
    return next(new AppError('Username is already taken. Please choose another.', 400));
  }

  res.status(200).json({
    status: 'success',
    message: 'Username is available.',
  });
});


exports.login = catchAsync(async (req, res, next) => {
  const { email, password } = req.body;

  // Kiểm tra nếu yêu cầu không có đủ thông tin
  if (!email || !password) {
    return next(new AppError('Vui lòng cung cấp tên người dùng/email và mật khẩu!', 400));
  }

  // Tìm người dùng bằng email hoặc tên người dùng
  const user = await User.findOne({
    $or: [{ email: email }, { username: email }] // `email` có thể là email hoặc tên người dùng
  }).select('+password');

  // Kiểm tra nếu người dùng không tồn tại hoặc mật khẩu không đúng
  if (!user || !(await user.correctPassword(password, user.password))) {
    return next(new AppError('Tên người dùng/email hoặc mật khẩu không đúng', 401));
  }

  // Nếu tìm thấy người dùng và mật khẩu đúng, tạo và gửi token
  createSendToken(user, 200, res);
});

exports.logout = (req, res) => {
  res.status(200).json({ status: 'success' });
};

exports.isLoggedIn = catchAsync(async (req, res, next) => {
  console.log('here');

  if (req.body.jwt) {
    // 1) verify token
    console.log(req.body.jwt);

    const decoded = await promisify(jwt.verify)(
      req.body.jwt,
      process.env.JWT_SECRET
    );
    // 2) Check if user still exists
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
      return res.status(400).json({
        status: 'fail',
        loggedIn: false,
        message: "User haven't logged in!",
      });
    }

    // 3) Check if user changed password after the token was issued
    if (currentUser.changedPasswordAfter(decoded.iat)) {
      return res.status(400).json({
        status: 'fail',
        loggedIn: false,
        message: 'User had changed password recently!',
      });
    }

    // THERE IS A LOGGED IN USER
    return res.status(200).json({
      status: 'success',
      loggedIn: true,
      user: currentUser,
      token: req.body.jwt,
      message: 'User is already logged in!',
    });
  }
  return res.status(400).json({
    status: 'fail',
    loggedIn: false,
    message: "User haven't logged in!",
  });
});

//Login with google
exports.googleLogin = catchAsync(async (req, res, next) => {
  const { token } = req.body;
  const ticket = await client.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  
  const payload = ticket.getPayload();
  
  // Kiểm tra xem email có đuôi .edu hay không
  if (!payload.email.endsWith('@fpt.edu.vn')) {
    return next(new AppError('Only @fpt.edu.vn email addresses are allowed', 403));
  }

  // Tìm người dùng trong cơ sở dữ liệu
  let user = await User.findOne({ email: payload.email });

  // Tạo tài khoản mới nếu người dùng chưa tồn tại
  if (!user) {
    user = await User.create({
      email: payload.email,
      username: payload.name, // Hoặc bạn có thể xử lý để tạo username từ tên đầy đủ
      password: crypto.randomBytes(16).toString('hex'), // Mật khẩu ngẫu nhiên, vì người dùng sẽ đăng nhập bằng Google
      studentCode: 'auto-generated-or-placeholder', // Có thể tạo mã sinh viên tự động nếu cần
      
    });
  }

  // Tạo và gửi token đến client
  createSendToken(user, 200, res);
});



// Authentication
exports.protect = catchAsync(async (req, res, next) => {
  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }
  if (!token) {
    return next(
      new AppError('You are not logged in! Please log in to get access.', 401)
    );
  }
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
  const freshUser = await User.findById(decoded.id);
  if (!freshUser) {
    return next(
      new AppError('The user belong to this token is no longer exist!', 401)
    );
  }
  if (freshUser.changedPasswordAfter(decoded.iat)) {
    return next(
      new AppError('User recently changed password! Please log in again.', 401)
    );
  }
  req.user = freshUser;
  next();
});
// Authorization
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return next(
        new AppError('You do not have permission to perform this action', 403)
      );
    }
    next();
  };
};
exports.forgotPassword = catchAsync(async (req, res, next) => {
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return next(new AppError('There is no user with this email address.', 404));
  }
  const resetToken = user.createPasswordResetToken();
  await user.save({ validateBeforeSave: false });
  try {
    const resetURL = `${req.protocol}://${req.get(
      'host'
    )}/api/v1/users/reset-password/${resetToken}`;
    await new Email(user, resetURL).sendResetPassword();
    // await sendEmail({
    //   email: user.email,
    //   subject: 'Your password reset token valid for 10 min',
    //   message,
    // });
    res.status(200).json({
      status: 'success',
      message: 'Token sent to email!',
    });
  } catch (error) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save({ validateBeforeSave: false });
    return next(
      new AppError(
        'There was an error in sending the email.Try again later!',
        500
      )
    );
  }
});
exports.resetPassword = catchAsync(async (req, res, next) => {
  const hashToken = crypto
    .createHash('sha256')
    .update(req.params.token)
    .digest('hex');
  const user = await User.findOne({
    passwordResetToken: hashToken,
    passwordResetExpires: { $gt: Date.now() },
  });
  if (!user) {
    return next(new AppError('Token is invalid or has expired!', 400));
  }
  user.password = req.body.password;
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  await user.save();
  createSendToken(user, 200, res);
});
exports.updatePassword = catchAsync(async (req, res, next) => {
  const user = await User.findById(req.user.id).select('+password');
  if (!(await user.correctPassword(req.body.oldPassword))) {
    return next(new AppError('Your current password is wrong!', 401));
  }
  user.password = req.body.newPassword;
  await user.save();
  createSendToken(user, 200, res);
});
