// @generated from tools/emit-corpus.ts by tools/emit-probe.mjs -- DO NOT EDIT.
//
// The real output of the real pipeline: esbuild bundle, then Babel to ES5
// with the same preset-env settings a deployed endpoint gets. `fo doctor
// --engines` runs this verbatim on PingAM and PingIDM, so the `emit:*` keys
// in engine-surface.json record whether OUR OUTPUT works on the engine, not
// whether a hand-written approximation of it does.
//
// Regenerate: node tools/emit-probe.mjs
(function () {
"use strict";

var _excluded = ["a"];
function _objectWithoutProperties(e, t) { if (null == e) return {}; var o, r, i = _objectWithoutPropertiesLoose(e, t); if (Object.getOwnPropertySymbols) { var n = Object.getOwnPropertySymbols(e); for (r = 0; r < n.length; r++) o = n[r], -1 === t.indexOf(o) && {}.propertyIsEnumerable.call(e, o) && (i[o] = e[o]); } return i; }
function _objectWithoutPropertiesLoose(r, e) { if (null == r) return {}; var t = {}; for (var n in r) if ({}.hasOwnProperty.call(r, n)) { if (-1 !== e.indexOf(n)) continue; t[n] = r[n]; } return t; }
function ownKeys(e, r) { var t = Object.keys(e); if (Object.getOwnPropertySymbols) { var o = Object.getOwnPropertySymbols(e); r && (o = o.filter(function (r) { return Object.getOwnPropertyDescriptor(e, r).enumerable; })), t.push.apply(t, o); } return t; }
function _objectSpread(e) { for (var r = 1; r < arguments.length; r++) { var t = null != arguments[r] ? arguments[r] : {}; r % 2 ? ownKeys(Object(t), !0).forEach(function (r) { _defineProperty(e, r, t[r]); }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function (r) { Object.defineProperty(e, r, Object.getOwnPropertyDescriptor(t, r)); }); } return e; }
function _defineProperty(e, r, t) { return (r = _toPropertyKey(r)) in e ? Object.defineProperty(e, r, { value: t, enumerable: !0, configurable: !0, writable: !0 }) : e[r] = t, e; }
function _toConsumableArray(r) { return _arrayWithoutHoles(r) || _iterableToArray(r) || _unsupportedIterableToArray(r) || _nonIterableSpread(); }
function _nonIterableSpread() { throw new TypeError("Invalid attempt to spread non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArray(r) { if ("undefined" != typeof Symbol && null != r[Symbol.iterator] || null != r["@@iterator"]) return Array.from(r); }
function _arrayWithoutHoles(r) { if (Array.isArray(r)) return _arrayLikeToArray(r); }
function _slicedToArray(r, e) { return _arrayWithHoles(r) || _iterableToArrayLimit(r, e) || _unsupportedIterableToArray(r, e) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t.return && (u = t.return(), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(r) { if (Array.isArray(r)) return r; }
function _inherits(t, e) { if ("function" != typeof e && null !== e) throw new TypeError("Super expression must either be null or a function"); t.prototype = Object.create(e && e.prototype, { constructor: { value: t, writable: !0, configurable: !0 } }), Object.defineProperty(t, "prototype", { writable: !1 }), e && _setPrototypeOf(t, e); }
function _setPrototypeOf(t, e) { return _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function (t, e) { return t.__proto__ = e, t; }, _setPrototypeOf(t, e); }
function _defineProperties(e, r) { for (var t = 0; t < r.length; t++) { var o = r[t]; o.enumerable = o.enumerable || !1, o.configurable = !0, "value" in o && (o.writable = !0), Object.defineProperty(e, _toPropertyKey(o.key), o); } }
function _createClass(e, r, t) { return r && _defineProperties(e.prototype, r), t && _defineProperties(e, t), Object.defineProperty(e, "prototype", { writable: !1 }), e; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _createForOfIteratorHelper(r, e) { var t = "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (!t) { if (Array.isArray(r) || (t = _unsupportedIterableToArray(r)) || e && r && "number" == typeof r.length) { t && (r = t); var _n = 0, F = function F() {}; return { s: F, n: function n() { return _n >= r.length ? { done: !0 } : { done: !1, value: r[_n++] }; }, e: function e(r) { throw r; }, f: F }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); } var o, a = !0, u = !1; return { s: function s() { t = t.call(r); }, n: function n() { var r = t.next(); return a = r.done, r; }, e: function e(r) { u = !0, o = r; }, f: function f() { try { a || null == t.return || t.return(); } finally { if (u) throw o; } } }; }
function _unsupportedIterableToArray(r, a) { if (r) { if ("string" == typeof r) return _arrayLikeToArray(r, a); var t = {}.toString.call(r).slice(8, -1); return "Object" === t && r.constructor && (t = r.constructor.name), "Map" === t || "Set" === t ? Array.from(r) : "Arguments" === t || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(t) ? _arrayLikeToArray(r, a) : void 0; } }
function _arrayLikeToArray(r, a) { (null == a || a > r.length) && (a = r.length); for (var e = 0, n = Array(a); e < a; e++) n[e] = r[e]; return n; }
function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
var __foMain = function () {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = function __export(target, all) {
    for (var name in all) __defProp(target, name, {
      get: all[name],
      enumerable: true
    });
  };
  var __copyProps = function __copyProps(to, from, except, desc) {
    if (from && _typeof(from) === "object" || typeof from === "function") {
      var _iterator = _createForOfIteratorHelper(__getOwnPropNames(from)),
        _step;
      try {
        var _loop = function _loop() {
          var key = _step.value;
          if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
            get: function get() {
              return from[key];
            },
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
          });
        };
        for (_iterator.s(); !(_step = _iterator.n()).done;) {
          _loop();
        }
      } catch (err) {
        _iterator.e(err);
      } finally {
        _iterator.f();
      }
    }
    return to;
  };
  var __toCommonJS = function __toCommonJS(mod) {
    return __copyProps(__defProp({}, "__esModule", {
      value: true
    }), mod);
  };
  var emit_corpus_exports = {};
  __export(emit_corpus_exports, {
    default: function _default() {
      return probe;
    }
  });
  function record(out, key, run) {
    try {
      out.push((run() ? "+" : "-") + "emit:" + key);
    } catch (_unused) {
      out.push("-emit:" + key);
    }
  }
  var Base = function () {
    function Base(tag) {
      this.tag = tag;
    }
    var _proto = Base.prototype;
    _proto.describe = function describe() {
      return "base:" + this.tag;
    };
    return _createClass(Base);
  }();
  var Derived = function (_Base) {
    function _Derived() {
      return _Base.apply(this, arguments) || this;
    }
    _inherits(_Derived, _Base);
    var _proto2 = _Derived.prototype;
    _proto2.describe = function describe() {
      return "derived:" + _Base.prototype.describe.call(this);
    };
    _Derived.of = function of(tag) {
      return new _Derived(tag);
    };
    return _createClass(_Derived, [{
      key: "shouted",
      get: function get() {
        return this.tag.toUpperCase();
      }
    }]);
  }(Base);
  function probe() {
    var out = [];
    record(out, "for-of-array", function () {
      var total = 0;
      for (var _i = 0, _arr = [1, 2, 3]; _i < _arr.length; _i++) {
        var value = _arr[_i];
        total += value;
      }
      return total === 6;
    });
    record(out, "for-of-set", function () {
      var seen = "";
      var _iterator2 = _createForOfIteratorHelper(new Set(["a", "b"])),
        _step2;
      try {
        for (_iterator2.s(); !(_step2 = _iterator2.n()).done;) {
          var value = _step2.value;
          seen += value;
        }
      } catch (err) {
        _iterator2.e(err);
      } finally {
        _iterator2.f();
      }
      return seen === "ab";
    });
    record(out, "for-of-map-entries", function () {
      var map = new Map([["k", 1]]);
      var seen = "";
      var _iterator3 = _createForOfIteratorHelper(map),
        _step3;
      try {
        for (_iterator3.s(); !(_step3 = _iterator3.n()).done;) {
          var _step3$value = _slicedToArray(_step3.value, 2),
            key = _step3$value[0],
            value = _step3$value[1];
          seen += key + value;
        }
      } catch (err) {
        _iterator3.e(err);
      } finally {
        _iterator3.f();
      }
      return seen === "k1";
    });
    record(out, "spread-array", function () {
      return [1, 2].concat([3, 4]).length === 4;
    });
    record(out, "spread-iterable", function () {
      return _toConsumableArray(new Set([1, 2, 2, 3])).length === 3;
    });
    record(out, "spread-object", function () {
      var base = {
        a: 1,
        b: 2
      };
      var merged = _objectSpread(_objectSpread({}, base), {}, {
        b: 3
      });
      return merged.a === 1 && merged.b === 3;
    });
    record(out, "destructure-array", function () {
      var first = 10,
        rest = [20, 30];
      return first === 10 && rest.length === 2;
    });
    record(out, "destructure-object", function () {
      var _a$b$c = {
          a: 1,
          b: 2,
          c: 3
        },
        a = _a$b$c.a,
        others = _objectWithoutProperties(_a$b$c, _excluded);
      return a === 1 && Object.keys(others).length === 2;
    });
    record(out, "params-default-rest", function () {
      var f = function f() {
        var a = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 1;
        return a + (arguments.length <= 1 ? 0 : arguments.length - 1);
      };
      return f() === 1 && f(2, 9, 9) === 4;
    });
    record(out, "class-inheritance", function () {
      var d = Derived.of("x");
      return d.describe() === "derived:base:x" && d.shouted === "X";
    });
    record(out, "template-literal", function () {
      var who = "world";
      return "hello ".concat(who) === "hello world";
    });
    record(out, "computed-key", function () {
      var k = "dyn";
      return _defineProperty({}, k + "1", true)["dyn1"] === true;
    });
    record(out, "optional-chaining", function () {
      var _maybe$inner$value, _maybe$inner;
      var maybe = {};
      return ((_maybe$inner$value = (_maybe$inner = maybe.inner) == null ? void 0 : _maybe$inner.value) != null ? _maybe$inner$value : 7) === 7;
    });
    return out;
  }
  return __toCommonJS(emit_corpus_exports);
}();
return __foMain.default();
})()
