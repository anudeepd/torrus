function z(e){return e&&e.__esModule&&Object.prototype.hasOwnProperty.call(e,"default")?e.default:e}var q={exports:{}},s={};/**
 * @license React
 * react.production.min.js
 *
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var b=Symbol.for("react.element"),re=Symbol.for("react.portal"),ne=Symbol.for("react.fragment"),oe=Symbol.for("react.strict_mode"),ue=Symbol.for("react.profiler"),se=Symbol.for("react.provider"),ae=Symbol.for("react.context"),ce=Symbol.for("react.forward_ref"),ie=Symbol.for("react.suspense"),le=Symbol.for("react.memo"),fe=Symbol.for("react.lazy"),I=Symbol.iterator;function ye(e){return e===null||typeof e!="object"?null:(e=I&&e[I]||e["@@iterator"],typeof e=="function"?e:null)}var U={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},F=Object.assign,B={};function _(e,t,r){this.props=e,this.context=t,this.refs=B,this.updater=r||U}_.prototype.isReactComponent={};_.prototype.setState=function(e,t){if(typeof e!="object"&&typeof e!="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,t,"setState")};_.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};function H(){}H.prototype=_.prototype;function R(e,t,r){this.props=e,this.context=t,this.refs=B,this.updater=r||U}var j=R.prototype=new H;j.constructor=R;F(j,_.prototype);j.isPureReactComponent=!0;var V=Array.isArray,W=Object.prototype.hasOwnProperty,M={current:null},N={key:!0,ref:!0,__self:!0,__source:!0};function G(e,t,r){var n,o={},u=null,a=null;if(t!=null)for(n in t.ref!==void 0&&(a=t.ref),t.key!==void 0&&(u=""+t.key),t)W.call(t,n)&&!N.hasOwnProperty(n)&&(o[n]=t[n]);var i=arguments.length-2;if(i===1)o.children=r;else if(1<i){for(var c=Array(i),l=0;l<i;l++)c[l]=arguments[l+2];o.children=c}if(e&&e.defaultProps)for(n in i=e.defaultProps,i)o[n]===void 0&&(o[n]=i[n]);return{$$typeof:b,type:e,key:u,ref:a,props:o,_owner:M.current}}function pe(e,t){return{$$typeof:b,type:e.type,key:t,ref:e.ref,props:e.props,_owner:e._owner}}function O(e){return typeof e=="object"&&e!==null&&e.$$typeof===b}function de(e){var t={"=":"=0",":":"=2"};return"$"+e.replace(/[=:]/g,function(r){return t[r]})}var L=/\/+/g;function $(e,t){return typeof e=="object"&&e!==null&&e.key!=null?de(""+e.key):t.toString(36)}function E(e,t,r,n,o){var u=typeof e;(u==="undefined"||u==="boolean")&&(e=null);var a=!1;if(e===null)a=!0;else switch(u){case"string":case"number":a=!0;break;case"object":switch(e.$$typeof){case b:case re:a=!0}}if(a)return a=e,o=o(a),e=n===""?"."+$(a,0):n,V(o)?(r="",e!=null&&(r=e.replace(L,"$&/")+"/"),E(o,t,r,"",function(l){return l})):o!=null&&(O(o)&&(o=pe(o,r+(!o.key||a&&a.key===o.key?"":(""+o.key).replace(L,"$&/")+"/")+e)),t.push(o)),1;if(a=0,n=n===""?".":n+":",V(e))for(var i=0;i<e.length;i++){u=e[i];var c=n+$(u,i);a+=E(u,t,r,c,o)}else if(c=ye(e),typeof c=="function")for(e=c.call(e),i=0;!(u=e.next()).done;)u=u.value,c=n+$(u,i++),a+=E(u,t,r,c,o);else if(u==="object")throw t=String(e),Error("Objects are not valid as a React child (found: "+(t==="[object Object]"?"object with keys {"+Object.keys(e).join(", ")+"}":t)+"). If you meant to render a collection of children, use an array instead.");return a}function w(e,t,r){if(e==null)return e;var n=[],o=0;return E(e,n,"","",function(u){return t.call(r,u,o++)}),n}function he(e){if(e._status===-1){var t=e._result;t=t(),t.then(function(r){(e._status===0||e._status===-1)&&(e._status=1,e._result=r)},function(r){(e._status===0||e._status===-1)&&(e._status=2,e._result=r)}),e._status===-1&&(e._status=0,e._result=t)}if(e._status===1)return e._result.default;throw e._result}var y={current:null},g={transition:null},ve={ReactCurrentDispatcher:y,ReactCurrentBatchConfig:g,ReactCurrentOwner:M};function X(){throw Error("act(...) is not supported in production builds of React.")}s.Children={map:w,forEach:function(e,t,r){w(e,function(){t.apply(this,arguments)},r)},count:function(e){var t=0;return w(e,function(){t++}),t},toArray:function(e){return w(e,function(t){return t})||[]},only:function(e){if(!O(e))throw Error("React.Children.only expected to receive a single React element child.");return e}};s.Component=_;s.Fragment=ne;s.Profiler=ue;s.PureComponent=R;s.StrictMode=oe;s.Suspense=ie;s.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=ve;s.act=X;s.cloneElement=function(e,t,r){if(e==null)throw Error("React.cloneElement(...): The argument must be a React element, but you passed "+e+".");var n=F({},e.props),o=e.key,u=e.ref,a=e._owner;if(t!=null){if(t.ref!==void 0&&(u=t.ref,a=M.current),t.key!==void 0&&(o=""+t.key),e.type&&e.type.defaultProps)var i=e.type.defaultProps;for(c in t)W.call(t,c)&&!N.hasOwnProperty(c)&&(n[c]=t[c]===void 0&&i!==void 0?i[c]:t[c])}var c=arguments.length-2;if(c===1)n.children=r;else if(1<c){i=Array(c);for(var l=0;l<c;l++)i[l]=arguments[l+2];n.children=i}return{$$typeof:b,type:e.type,key:o,ref:u,props:n,_owner:a}};s.createContext=function(e){return e={$$typeof:ae,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:se,_context:e},e.Consumer=e};s.createElement=G;s.createFactory=function(e){var t=G.bind(null,e);return t.type=e,t};s.createRef=function(){return{current:null}};s.forwardRef=function(e){return{$$typeof:ce,render:e}};s.isValidElement=O;s.lazy=function(e){return{$$typeof:fe,_payload:{_status:-1,_result:e},_init:he}};s.memo=function(e,t){return{$$typeof:le,type:e,compare:t===void 0?null:t}};s.startTransition=function(e){var t=g.transition;g.transition={};try{e()}finally{g.transition=t}};s.unstable_act=X;s.useCallback=function(e,t){return y.current.useCallback(e,t)};s.useContext=function(e){return y.current.useContext(e)};s.useDebugValue=function(){};s.useDeferredValue=function(e){return y.current.useDeferredValue(e)};s.useEffect=function(e,t){return y.current.useEffect(e,t)};s.useId=function(){return y.current.useId()};s.useImperativeHandle=function(e,t,r){return y.current.useImperativeHandle(e,t,r)};s.useInsertionEffect=function(e,t){return y.current.useInsertionEffect(e,t)};s.useLayoutEffect=function(e,t){return y.current.useLayoutEffect(e,t)};s.useMemo=function(e,t){return y.current.useMemo(e,t)};s.useReducer=function(e,t,r){return y.current.useReducer(e,t,r)};s.useRef=function(e){return y.current.useRef(e)};s.useState=function(e){return y.current.useState(e)};s.useSyncExternalStore=function(e,t,r){return y.current.useSyncExternalStore(e,t,r)};s.useTransition=function(){return y.current.useTransition()};s.version="18.3.1";q.exports=s;var m=q.exports;const me=z(m),ke={},D=e=>{let t;const r=new Set,n=(p,k)=>{const h=typeof p=="function"?p(t):p;if(!Object.is(h,t)){const d=t;t=k??(typeof h!="object"||h===null)?h:Object.assign({},t,h),r.forEach(v=>v(t,d))}},o=()=>t,c={setState:n,getState:o,getInitialState:()=>l,subscribe:p=>(r.add(p),()=>r.delete(p)),destroy:()=>{(ke?"production":void 0)!=="production"&&console.warn("[DEPRECATED] The `destroy` method will be unsupported in a future version. Instead use unsubscribe function returned by subscribe. Everything will be garbage-collected if store is garbage-collected."),r.clear()}},l=t=e(n,o,c);return c},Se=e=>e?D(e):D;var K={exports:{}},J={},Q={exports:{}},Y={};/**
 * @license React
 * use-sync-external-store-shim.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var S=m;function _e(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var be=typeof Object.is=="function"?Object.is:_e,we=S.useState,Ee=S.useEffect,ge=S.useLayoutEffect,xe=S.useDebugValue;function $e(e,t){var r=t(),n=we({inst:{value:r,getSnapshot:t}}),o=n[0].inst,u=n[1];return ge(function(){o.value=r,o.getSnapshot=t,C(o)&&u({inst:o})},[e,r,t]),Ee(function(){return C(o)&&u({inst:o}),e(function(){C(o)&&u({inst:o})})},[e]),xe(r),r}function C(e){var t=e.getSnapshot;e=e.value;try{var r=t();return!be(e,r)}catch{return!0}}function Ce(e,t){return t()}var Re=typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"?Ce:$e;Y.useSyncExternalStore=S.useSyncExternalStore!==void 0?S.useSyncExternalStore:Re;Q.exports=Y;var je=Q.exports;/**
 * @license React
 * use-sync-external-store-shim/with-selector.production.js
 *
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */var x=m,Me=je;function Oe(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var Pe=typeof Object.is=="function"?Object.is:Oe,Ie=Me.useSyncExternalStore,Ve=x.useRef,Le=x.useEffect,De=x.useMemo,Te=x.useDebugValue;J.useSyncExternalStoreWithSelector=function(e,t,r,n,o){var u=Ve(null);if(u.current===null){var a={hasValue:!1,value:null};u.current=a}else a=u.current;u=De(function(){function c(d){if(!l){if(l=!0,p=d,d=n(d),o!==void 0&&a.hasValue){var v=a.value;if(o(v,d))return k=v}return k=d}if(v=k,Pe(p,d))return v;var P=n(d);return o!==void 0&&o(v,P)?(p=d,v):(p=d,k=P)}var l=!1,p,k,h=r===void 0?null:r;return[function(){return c(t())},h===null?void 0:function(){return c(h())}]},[t,r,n,o]);var i=Ie(e,u[0],u[1]);return Le(function(){a.hasValue=!0,a.value=i},[i]),Te(i),i};K.exports=J;var Ae=K.exports;const ze=z(Ae),Z={},{useDebugValue:qe}=me,{useSyncExternalStoreWithSelector:Ue}=ze;let T=!1;const Fe=e=>e;function Be(e,t=Fe,r){(Z?"production":void 0)!=="production"&&r&&!T&&(console.warn("[DEPRECATED] Use `createWithEqualityFn` instead of `create` or use `useStoreWithEqualityFn` instead of `useStore`. They can be imported from 'zustand/traditional'. https://github.com/pmndrs/zustand/discussions/1937"),T=!0);const n=Ue(e.subscribe,e.getState,e.getServerState||e.getInitialState,t,r);return qe(n),n}const A=e=>{(Z?"production":void 0)!=="production"&&typeof e!="function"&&console.warn("[DEPRECATED] Passing a vanilla store will be unsupported in a future version. Instead use `import { useStore } from 'zustand'`.");const t=typeof e=="function"?Se(e):e,r=(n,o)=>Be(t,n,o);return Object.assign(r,t),r},Ge=e=>e?A(e):A;/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const He=e=>e.replace(/([a-z0-9])([A-Z])/g,"$1-$2").toLowerCase(),ee=(...e)=>e.filter((t,r,n)=>!!t&&t.trim()!==""&&n.indexOf(t)===r).join(" ").trim();/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */var We={xmlns:"http://www.w3.org/2000/svg",width:24,height:24,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:2,strokeLinecap:"round",strokeLinejoin:"round"};/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ne=m.forwardRef(({color:e="currentColor",size:t=24,strokeWidth:r=2,absoluteStrokeWidth:n,className:o="",children:u,iconNode:a,...i},c)=>m.createElement("svg",{ref:c,...We,width:t,height:t,stroke:e,strokeWidth:n?Number(r)*24/Number(t):r,className:ee("lucide",o),...i},[...a.map(([l,p])=>m.createElement(l,p)),...Array.isArray(u)?u:[u]]));/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const f=(e,t)=>{const r=m.forwardRef(({className:n,...o},u)=>m.createElement(Ne,{ref:u,iconNode:t,className:ee(`lucide-${He(e)}`,n),...o}));return r.displayName=`${e}`,r};/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Xe=f("Bookmark",[["path",{d:"m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z",key:"1fy3hk"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ke=f("Copy",[["rect",{width:"14",height:"14",x:"8",y:"8",rx:"2",ry:"2",key:"17jyea"}],["path",{d:"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",key:"zix9uf"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Je=f("Download",[["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}],["polyline",{points:"7 10 12 15 17 10",key:"2ggqvy"}],["line",{x1:"12",x2:"12",y1:"15",y2:"3",key:"1vk2je"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Qe=f("GitFork",[["circle",{cx:"12",cy:"18",r:"3",key:"1mpf1b"}],["circle",{cx:"6",cy:"6",r:"3",key:"1lh9wr"}],["circle",{cx:"18",cy:"6",r:"3",key:"1h7g24"}],["path",{d:"M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9",key:"1uq4wg"}],["path",{d:"M12 12v3",key:"158kv8"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ye=f("LogIn",[["path",{d:"M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4",key:"u53s6r"}],["polyline",{points:"10 17 15 12 10 7",key:"1ail0h"}],["line",{x1:"15",x2:"3",y1:"12",y2:"12",key:"v6grx8"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Ze=f("LogOut",[["path",{d:"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4",key:"1uf3rs"}],["polyline",{points:"16 17 21 12 16 7",key:"1gabdz"}],["line",{x1:"21",x2:"9",y1:"12",y2:"12",key:"1uyos4"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const et=f("PanelLeftClose",[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",key:"afitv7"}],["path",{d:"M9 3v18",key:"fh3hqa"}],["path",{d:"m16 15-3-3 3-3",key:"14y99z"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const tt=f("PanelLeftOpen",[["rect",{width:"18",height:"18",x:"3",y:"3",rx:"2",key:"afitv7"}],["path",{d:"M9 3v18",key:"fh3hqa"}],["path",{d:"m14 9 3 3-3 3",key:"8010ee"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const rt=f("Pencil",[["path",{d:"M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z",key:"1a8usu"}],["path",{d:"m15 5 4 4",key:"1mk7zo"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const nt=f("Plus",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ot=f("RotateCcw",[["path",{d:"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8",key:"1357e3"}],["path",{d:"M3 3v5h5",key:"1xhq8a"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ut=f("Settings",[["path",{d:"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",key:"1qme2f"}],["circle",{cx:"12",cy:"12",r:"3",key:"1v7zrd"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const st=f("Terminal",[["polyline",{points:"4 17 10 11 4 5",key:"akl6gq"}],["line",{x1:"12",x2:"20",y1:"19",y2:"19",key:"q2wloq"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const at=f("Trash2",[["path",{d:"M3 6h18",key:"d0wm0j"}],["path",{d:"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6",key:"4alrt4"}],["path",{d:"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2",key:"v07s0e"}],["line",{x1:"10",x2:"10",y1:"11",y2:"17",key:"1uufr5"}],["line",{x1:"14",x2:"14",y1:"11",y2:"17",key:"xtxkd"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ct=f("Upload",[["path",{d:"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4",key:"ih7n3h"}],["polyline",{points:"17 8 12 3 7 8",key:"t8dd8p"}],["line",{x1:"12",x2:"12",y1:"3",y2:"15",key:"widbto"}]]);/**
 * @license lucide-react v0.460.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const it=f("X",[["path",{d:"M18 6 6 18",key:"1bl5f8"}],["path",{d:"m6 6 12 12",key:"d8bk6v"}]]);function te(e){var t,r,n="";if(typeof e=="string"||typeof e=="number")n+=e;else if(typeof e=="object")if(Array.isArray(e)){var o=e.length;for(t=0;t<o;t++)e[t]&&(r=te(e[t]))&&(n&&(n+=" "),n+=r)}else for(r in e)e[r]&&(n&&(n+=" "),n+=r);return n}function lt(){for(var e,t,r=0,n="",o=arguments.length;r<o;r++)(e=arguments[r])&&(t=te(e))&&(n&&(n+=" "),n+=t);return n}export{Xe as B,Ke as C,Je as D,Qe as G,Ze as L,nt as P,ot as R,ut as S,at as T,ct as U,it as X,lt as a,et as b,Ge as c,rt as d,tt as e,Ye as f,st as g,m as r};
